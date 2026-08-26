import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    computeContentPublicKeyFingerprint,
    type SessionTranscriptObservationProvenanceV1,
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { createEnvPatcher } from "@/testkit/env";
import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

type MockFunction = ReturnType<typeof vi.fn>;
type SessionWriteTxMock = {
    $queryRawUnsafe?: MockFunction;
    $executeRawUnsafe?: MockFunction;
    account: {
        findUnique: MockFunction;
    };
    session: {
        findUnique: MockFunction;
        findFirst: MockFunction;
        update: MockFunction;
        updateMany: MockFunction;
    };
    sessionShare: {
        findUnique: MockFunction;
    };
    sessionMessage: {
        findFirst: MockFunction;
        findUnique: MockFunction;
        findMany: MockFunction;
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
let transactionQueue: SessionWriteTxMock[] = [];

function createAccountContentBinding() {
    const signingKeyPair = tweetnacl.sign.keyPair();
    const contentKeyPair = tweetnacl.box.keyPair();
    const signedPayload = Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(contentKeyPair.publicKey),
    ]);
    return {
        publicKey: Buffer.from(signingKeyPair.publicKey).toString("hex"),
        contentPublicKey: Buffer.from(contentKeyPair.publicKey),
        contentPublicKeySig: Buffer.from(
            tweetnacl.sign.detached(
                signedPayload,
                signingKeyPair.secretKey,
            ),
        ),
        fingerprint: computeContentPublicKeyFingerprint(
            new Uint8Array(contentKeyPair.publicKey),
        ),
    };
}

function hostedTranscriptPublication(accountId = "u1") {
    return {
        accountId,
        currentStorageState: "hosted" as const,
    };
}

const hasCurrentSessionScopedMachineAccessInTx = vi.fn(async () => true);
vi.mock("@/app/api/socket/sessionScopedBinding", () => ({ hasCurrentSessionScopedMachineAccessInTx }));

vi.mock("@/storage/inTx", () => ({
    inTx: async <T>(fn: (tx: SessionWriteTxMock) => T | Promise<T>) => await fn(transactionQueue.shift() ?? currentTx),
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
    sessionMessage: ["findUnique", "findMany"],
} as const);
installDbModuleMock({ db: dbMocks.db });

const sessionWriteServicePromise = import("./sessionWriteService");

let createSessionMessage: typeof import("./sessionWriteService").createSessionMessage;
let patchSession: typeof import("./sessionWriteService").patchSession;
let updateSessionMetadataEnvelopeTuple: typeof import("./sessionWriteService").updateSessionMetadataEnvelopeTuple;
let applySessionReadCursorOperation: typeof import("./sessionWriteService").applySessionReadCursorOperation;
let applySessionTurnMutation: typeof import("./sessionWriteService").applySessionTurnMutation;
let reassertSessionLatestTurnStatus: typeof import("./sessionWriteService").reassertSessionLatestTurnStatus;
let sessionWriteServiceExports: typeof import("./sessionWriteService");
let updateSessionAgentState: typeof import("./sessionWriteService").updateSessionAgentState;
let updateSessionMetadata: typeof import("./sessionWriteService").updateSessionMetadata;
let updateSessionReadCursor: typeof import("./sessionWriteService").updateSessionReadCursor;
let updateSessionRuntimeActivityProjection: typeof import("./sessionWriteService").updateSessionRuntimeActivityProjection;

describe("sessionWriteService", () => {
    const storagePolicyEnv = createEnvPatcher([
        "HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY",
        "HAPPIER_DB_PROVIDER",
    ]);

    beforeAll(async () => {
        const service: typeof import("./sessionWriteService") = await sessionWriteServicePromise;
        sessionWriteServiceExports = service;
        ({
            applySessionReadCursorOperation,
            createSessionMessage,
            patchSession,
            updateSessionMetadataEnvelopeTuple,
            updateSessionAgentState,
            updateSessionMetadata,
            updateSessionReadCursor,
            updateSessionRuntimeActivityProjection,
        } = service);
        applySessionTurnMutation = service.applySessionTurnMutation;
        reassertSessionLatestTurnStatus = service.reassertSessionLatestTurnStatus;
    }, 60_000);

    beforeEach(() => {
        getSessionParticipantUserIds.mockReset();
        markAccountChanged.mockReset();
        observeCreateSessionMessageStage.mockReset();
        sessionMessageRoleMismatchCounter.inc.mockReset();
        dbMocks.reset();
        storagePolicyEnv.restore();
        transactionQueue = [];

        currentTx = {
            account: {
                findUnique: vi.fn(),
            },
            session: {
                findUnique: vi.fn(),
                findFirst: vi.fn().mockResolvedValue({ id: "s1" }),
                update: vi.fn(),
                updateMany: vi.fn(),
            },
            sessionShare: {
                findUnique: vi.fn(),
            },
            sessionMessage: {
                findFirst: vi.fn(),
                findUnique: vi.fn(),
                findMany: vi.fn(),
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

    describe("reassertSessionLatestTurnStatus", () => {
        it("repairs the denormalized session projection only from the matching canonical turn row", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [],
                    seq: 10,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "in_progress",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    seq: 10,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                turnId: "turn-1",
                status: "completed",
                updatedAt: BigInt(200),
                lastRuntimeIssueJson: null,
            });
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValue(201);

            const result = await reassertSessionLatestTurnStatus({
                actorUserId: "u1",
                sessionId: "s1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
            });

            expect(currentTx.sessionTurn.findUnique).toHaveBeenCalledWith({
                where: { sessionId_turnId: { sessionId: "s1", turnId: "turn-1" } },
                select: {
                    turnId: true,
                    status: true,
                    updatedAt: true,
                    lastRuntimeIssueJson: true,
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
            expect(result).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
            });
        });

        it("does not trust a client status that does not match the canonical turn row", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [],
                    seq: 10,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "in_progress",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    seq: 10,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                turnId: "turn-1",
                status: "in_progress",
                updatedAt: BigInt(200),
                lastRuntimeIssueJson: null,
            });

            const result = await reassertSessionLatestTurnStatus({
                actorUserId: "u1",
                sessionId: "s1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
            });

            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(result).toMatchObject({ ok: true, didApply: false, latestTurnStatus: "in_progress" });
        });
    });

    describe("updateSessionRuntimeActivityProjection", () => {
        const owner = {
            accountId: "u1",
            encryptionMode: "plain",
            shares: [{ sharedWithUserId: "u2" }],
            seq: 10,
            pendingCount: 0,
            pendingBlockedCount: 0,
            lastViewedSessionSeq: null,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: "completed",
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
            lastActiveAt: new Date(500),
        };

        it("server-stamps and revision-orders a strict snapshot", async () => {
            vi.spyOn(Date, "now").mockReturnValue(1_000);
            currentTx.session.findUnique
                .mockResolvedValueOnce(owner)
                .mockResolvedValueOnce({
                    runtimeActivityState: "idle",
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: BigInt(900),
                    runtimeActivityRevision: BigInt(4),
                })
                .mockResolvedValueOnce(hostedTranscriptPublication());
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);

            const res = await updateSessionRuntimeActivityProjection({
                accountId: "u1",
                machineId: "m1",
                sessionId: "s1",
                boundCommittedFence: new Date(500),
                state: "active",
                activeCount: 1,
            });

            expect(res).toMatchObject({
                status: "applied",
                projection: {
                    runtimeActivityState: "active",
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 1_000,
                    runtimeActivityRevision: 5,
                },
            });
            expect(res).not.toHaveProperty("becameIdle");
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", runtimeActivityRevision: BigInt(4) },
                data: {
                    runtimeActivityState: "active",
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: BigInt(1_000),
                    runtimeActivityRevision: BigInt(5),
                },
            });
            expect(markAccountChanged).toHaveBeenCalledTimes(2);
        });

        it("preserves revision and suppresses participant fanout for an unchanged idle snapshot", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce(owner)
                .mockResolvedValueOnce({
                    runtimeActivityState: "idle",
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: BigInt(900),
                    runtimeActivityRevision: BigInt(4),
                });
            const res = await updateSessionRuntimeActivityProjection({
                accountId: "u1",
                machineId: "m1",
                sessionId: "s1",
                boundCommittedFence: new Date(500),
                state: "idle",
                activeCount: 0,
            });
            expect(res).toMatchObject({ status: "unchanged", projection: { runtimeActivityRevision: 4 } });
            expect(res).not.toHaveProperty("becameIdle");
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it.each(["active", "unknown"] as const)(
            "marks a committed %s-to-idle transition for post-commit Pending reconciliation",
            async (previousState) => {
                currentTx.session.findUnique
                    .mockResolvedValueOnce(owner)
                    .mockResolvedValueOnce({
                        runtimeActivityState: previousState,
                        runtimeActivityActiveCount: previousState === "active" ? 1 : 0,
                        runtimeActivityObservedAt: BigInt(900),
                        runtimeActivityRevision: BigInt(4),
                    });
                currentTx.session.updateMany.mockResolvedValue({ count: 1 });
                getSessionParticipantUserIds.mockResolvedValue(["u1"]);

                const res = await updateSessionRuntimeActivityProjection({
                    accountId: "u1",
                    machineId: "m1",
                    sessionId: "s1",
                    boundCommittedFence: new Date(500),
                    state: "idle",
                    activeCount: 0,
                });

                expect(res).toMatchObject({
                    status: "applied",
                    becameIdle: true,
                    projection: { runtimeActivityState: "idle", runtimeActivityRevision: 5 },
                });
            },
        );

        it("does not mark an applied unknown projection as an idle transition", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce(owner)
                .mockResolvedValueOnce({
                    runtimeActivityState: "active",
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: BigInt(900),
                    runtimeActivityRevision: BigInt(4),
                });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);

            const res = await updateSessionRuntimeActivityProjection({
                accountId: "u1",
                machineId: "m1",
                sessionId: "s1",
                boundCommittedFence: new Date(500),
                state: "unknown",
                activeCount: 0,
            });

            expect(res).toMatchObject({ status: "applied", projection: { runtimeActivityState: "unknown" } });
            expect(res).not.toHaveProperty("becameIdle");
        });

        it("rejects malformed or cross-field-inconsistent snapshots", async () => {
            const res = await updateSessionRuntimeActivityProjection({
                accountId: "u1",
                machineId: "m1",
                sessionId: "s1",
                boundCommittedFence: new Date(500),
                state: "idle",
                activeCount: 1,
            });
            expect(res).toEqual({ status: "rejected", reason: "invalid-params" });
            expect(currentTx.session.findUnique).not.toHaveBeenCalled();
        });

        it("rejects malformed stored projections instead of normalizing them to unknown", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce(owner)
                .mockResolvedValueOnce({
                    runtimeActivityState: "active",
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: BigInt(900),
                    runtimeActivityRevision: 4.5,
                });

            const res = await updateSessionRuntimeActivityProjection({
                accountId: "u1",
                machineId: "m1",
                sessionId: "s1",
                boundCommittedFence: new Date(500),
                state: "idle",
                activeCount: 0,
            });

            expect(res).toEqual({ status: "rejected", reason: "invalid_storage" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects malformed stored projections while clearing instead of fabricating unknown", async () => {
            currentTx.session.findUnique.mockResolvedValueOnce({
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(900),
                runtimeActivityRevision: -1,
            });

            await expect(sessionWriteServiceExports.clearSessionRuntimeActivityProjectionInTx({
                tx: currentTx as unknown as Parameters<
                    typeof sessionWriteServiceExports.clearSessionRuntimeActivityProjectionInTx
                >[0]["tx"],
                sessionId: "s1",
            })).rejects.toThrow(/invalid stored runtime activity projection/i);
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("does not return a synthetic tuple when an unknown stored projection needs no clear", async () => {
            currentTx.session.findUnique.mockResolvedValueOnce({
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: BigInt(0),
            });

            await expect(sessionWriteServiceExports.clearSessionRuntimeActivityProjectionInTx({
                tx: currentTx as unknown as Parameters<
                    typeof sessionWriteServiceExports.clearSessionRuntimeActivityProjectionInTx
                >[0]["tx"],
                sessionId: "s1",
            })).resolves.toEqual({ didWrite: false });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });
    });

    describe("createSessionMessage", () => {
        it("persists trusted history chronology only while the exact publisher fence is current", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const committedFence = new Date("2026-07-20T10:00:00.000Z");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    runtimeActivityRevision: BigInt(1),
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "plain",
                    shares: [],
                    seq: 0,
                    lastViewedSessionSeq: 0,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 1 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            const ingestedAt = new Date("2026-07-20T11:00:00.000Z");
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-history",
                seq: 1,
                localId: " historical-id ",
                sidechainId: null,
                messageRole: "agent",
                rowRevision: BigInt(0),
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "old" } } } as const,
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(200),
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                createdAt: ingestedAt,
                updatedAt: ingestedAt,
            });
            markAccountChanged.mockResolvedValue(2);

            const result = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: " historical-id ",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "old" } } },
                messageRole: "agent",
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 200 },
                trustedTranscriptObservationProvenance: { kind: "non_dependent", source: "history" },
                trustedAttentionImpact: { affectsUnread: false, affectsMeaningfulActivity: false },
            });

            expect(result).toMatchObject({
                ok: true,
                didWrite: true,
                message: {
                    localId: " historical-id ",
                    sourceCreatedAt: new Date(100),
                    sourceUpdatedAt: new Date(200),
                    transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                    createdAt: ingestedAt,
                },
                badgeAttentionChanged: false,
            });
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    localId: " historical-id ",
                    sourceCreatedAt: new Date(100),
                    sourceUpdatedAt: new Date(200),
                    transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                }),
            }));
        });

        it("rejects trusted chronology after the publisher fence is superseded", async () => {
            currentTx.session.findUnique.mockResolvedValue({
                active: true,
                archivedAt: null,
                lastActiveAt: new Date(2),
                runtimeActivityRevision: BigInt(1),
            });

            const result = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "history-id",
                ciphertext: "cipher",
                publisherAuthority: {
                    accountId: "u1",
                    machineId: "machine-1",
                    sessionId: "s1",
                    committedFence: new Date(1),
                },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 100 },
                trustedTranscriptObservationProvenance: { kind: "non_dependent", source: "history" },
            });

            expect(result).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
        });

        it("rejects trusted chronology when publisher replacement wins after validation but before persistence", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const committedFence = new Date("2026-07-20T10:00:00.000Z");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    runtimeActivityRevision: BigInt(1),
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "plain",
                    shares: [],
                    seq: 0,
                    lastViewedSessionSeq: 0,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 0 });
            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-raced-history",
                seq: 1,
                localId: "history-raced-by-successor",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "old" } } },
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(100),
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                createdAt: new Date(300),
                updatedAt: new Date(300),
            });
            markAccountChanged.mockResolvedValue(2);

            const result = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "history-raced-by-successor",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "old" } } },
                messageRole: "agent",
                publisherAuthority: {
                    accountId: "u1",
                    machineId: "machine-1",
                    sessionId: "s1",
                    committedFence,
                },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 100 },
                trustedTranscriptObservationProvenance: { kind: "non_dependent", source: "history" },
            });

            expect(result).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
        });

        it("deduplicates the exact historical identity and rejects chronology regression", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const committedFence = new Date(10);
            const accessRows = () => {
                currentTx.session.findUnique
                    .mockResolvedValueOnce({ active: true, archivedAt: null, lastActiveAt: committedFence, runtimeActivityRevision: BigInt(1) })
                    .mockResolvedValueOnce({ accountId: "u1", encryptionMode: "plain", shares: [], active: true, archivedAt: null });
                currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            };
            const existing = {
                id: "m-history",
                seq: 4,
                localId: "history-id",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "old" } } } as const,
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(200),
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                createdAt: new Date(300),
                updatedAt: new Date(300),
            };
            const base = {
                actorUserId: "u1",
                sessionId: "s1",
                localId: "history-id",
                content: existing.content,
                messageRole: "agent" as const,
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedTranscriptObservationProvenance: { kind: "non_dependent" as const, source: "history" as const },
            };

            accessRows();
            currentTx.sessionMessage.findUnique.mockResolvedValueOnce(existing);
            await expect(createSessionMessage({
                ...base,
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 200 },
            })).resolves.toMatchObject({ ok: true, didWrite: false, didUpdate: false });
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();

            currentTx.session.findUnique.mockReset();
            accessRows();
            currentTx.sessionMessage.findUnique.mockResolvedValueOnce(existing);
            await expect(createSessionMessage({
                ...base,
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 199 },
            })).resolves.toEqual({ ok: false, error: "invalid-params" });
            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
        });

        it("accepts recovered history for an already-committed legacy localId without rewriting the legacy row", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const committedFence = new Date(10);
            const existing = {
                id: "m-legacy-history",
                seq: 4,
                localId: "legacy-history-id",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "already committed" } } } as const,
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                transcriptObservationProvenance: null,
                rowRevision: BigInt(0),
                createdAt: new Date(300),
                updatedAt: new Date(300),
            };
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    runtimeActivityRevision: BigInt(1),
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "plain",
                    shares: [],
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            currentTx.sessionMessage.findUnique.mockResolvedValueOnce(existing);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: existing.localId,
                content: existing.content,
                messageRole: "agent",
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 200 },
                trustedTranscriptObservationProvenance: { kind: "non_dependent", source: "history" },
            })).resolves.toMatchObject({
                ok: true,
                didWrite: false,
                didUpdate: false,
                message: { id: existing.id, localId: existing.localId },
                participantCursors: [],
            });

            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("still rejects non-history provenance over an already-committed legacy localId", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const committedFence = new Date(10);
            const existing = {
                id: "m-legacy-live",
                seq: 4,
                localId: "legacy-live-id",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "already committed" } } } as const,
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                transcriptObservationProvenance: null,
                rowRevision: BigInt(0),
                createdAt: new Date(300),
                updatedAt: new Date(300),
            };
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    runtimeActivityRevision: BigInt(1),
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "plain",
                    shares: [],
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            currentTx.sessionMessage.findUnique.mockResolvedValueOnce(existing);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: existing.localId,
                content: existing.content,
                messageRole: "agent",
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 200 },
                trustedTranscriptObservationProvenance: { kind: "non_dependent", source: "external" },
            })).resolves.toEqual({ ok: false, error: "invalid-params" });

            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects a newer trusted duplicate observation when snapshot publication owns transcript storage", async () => {
            const committedFence = new Date(10);
            const existing = {
                id: "m-snapshot-owned",
                seq: 4,
                localId: "snapshot-owned-observation",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "encrypted" as const, c: "cipher" },
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(200),
                transcriptObservationProvenance: { kind: "non_dependent" as const, source: "history" as const },
                createdAt: new Date(300),
                updatedAt: new Date(300),
            };
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    updatedAt: committedFence,
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [{ sharedWithUserId: "u2" }],
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({ currentStorageState: "snapshot_complete" });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.findUnique.mockResolvedValue(existing);
            currentTx.sessionMessage.update.mockResolvedValue({
                ...existing,
                sourceUpdatedAt: new Date(201),
            });
            markAccountChanged.mockResolvedValue(101);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: existing.localId,
                content: existing.content,
                messageRole: "agent",
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 201 },
                trustedTranscriptObservationProvenance: existing.transcriptObservationProvenance,
            })).resolves.toEqual({
                ok: false,
                error: "invalid-params",
                code: "session_storage_authority_mismatch",
            });

            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("does not advance trusted currentness for a structured snapshot before its reader floor exists", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const committedFence = new Date(10);
            const structuredContent = {
                t: "plain" as const,
                v: {
                    v: 1,
                    profile: "pluginTranscriptV1",
                    owner: { pluginId: "acme.preview", contributionLocalId: "review-card" },
                    snapshot: { kind: "text", text: "must not advance" },
                },
            };
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    runtimeActivityRevision: BigInt(1),
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "plain",
                    shares: [],
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            currentTx.sessionMessage.findUnique.mockResolvedValueOnce({
                id: "m-structured",
                seq: 4,
                localId: "history-structured",
                sidechainId: null,
                messageRole: "agent",
                content: structuredContent,
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(200),
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                createdAt: new Date(300),
                updatedAt: new Date(300),
            });
            // Without the publication admission below, the trusted-currentness
            // path would accept the retry and advance this source watermark.
            currentTx.sessionMessage.update.mockResolvedValueOnce({
                id: "m-structured",
                seq: 4,
                localId: "history-structured",
                sidechainId: null,
                messageRole: "agent",
                content: structuredContent,
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(201),
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                createdAt: new Date(300),
                updatedAt: new Date(300),
            });

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "history-structured",
                content: structuredContent,
                messageRole: "agent",
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 201 },
                trustedTranscriptObservationProvenance: { kind: "non_dependent", source: "history" },
            })).resolves.toEqual({
                ok: false,
                error: "invalid-params",
                code: "session_structured_presentation_unavailable",
            });

            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
        });

        it.each(["existing", "p2002-race"] as const)(
            "advances identical trusted chronology without publishing a content update through the %s path",
            async (path) => {
                storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
                const committedFence = new Date(10);
                const authorityRow = {
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    runtimeActivityRevision: BigInt(1),
                };
                const accessRow = {
                    accountId: "u1",
                    encryptionMode: "plain",
                    shares: [],
                    active: true,
                    archivedAt: null,
                };
                const existing = {
                    id: "m-history",
                    seq: 4,
                    localId: "history-id",
                    sidechainId: null,
                    messageRole: "agent",
                    rowRevision: BigInt(0),
                    content: { t: "plain", v: { role: "agent", content: { type: "text", text: "same" } } } as const,
                    sourceCreatedAt: new Date(100),
                    sourceUpdatedAt: new Date(200),
                    transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                    createdAt: new Date(300),
                    updatedAt: new Date(300),
                };
                const watermarked = {
                    ...existing,
                    sourceUpdatedAt: new Date(201),
                    updatedAt: new Date(301),
                };
                const base = {
                    actorUserId: "u1",
                    sessionId: "s1",
                    localId: "history-id",
                    messageRole: "agent" as const,
                    publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                    trustedTranscriptObservationProvenance: { kind: "non_dependent" as const, source: "history" as const },
                };
                const arrangePath = (row: typeof existing) => {
                    currentTx.session.findUnique.mockReset();
                    currentTx.sessionMessage.findUnique.mockReset();
                    currentTx.sessionMessage.create.mockReset();
                    currentTx.sessionMessage.update.mockReset();
                    currentTx.session.update.mockReset();
                    currentTx.session.updateMany.mockReset();
                    currentTx.session.updateMany.mockResolvedValue({ count: 1 });
                    currentTx.session.findUnique
                        .mockResolvedValueOnce(authorityRow)
                        .mockResolvedValueOnce(accessRow);
                    if (path === "existing") {
                        currentTx.session.findUnique.mockResolvedValueOnce(hostedTranscriptPublication());
                        currentTx.sessionMessage.findUnique.mockResolvedValueOnce(row);
                    } else {
                        currentTx.session.findUnique
                            .mockResolvedValueOnce(authorityRow)
                            .mockResolvedValueOnce(accessRow)
                            .mockResolvedValueOnce(hostedTranscriptPublication());
                        currentTx.session.update.mockResolvedValue({ seq: 5 });
                        currentTx.sessionMessage.findUnique
                            .mockResolvedValueOnce(null)
                            .mockResolvedValueOnce(row);
                        currentTx.sessionMessage.create.mockRejectedValueOnce({
                            code: "P2002",
                            meta: { target: ["sessionId", "localId"] },
                        });
                    }
                };

                arrangePath(existing);
                currentTx.sessionMessage.update.mockResolvedValueOnce(watermarked);
                const advanced = await createSessionMessage({
                    ...base,
                    content: existing.content,
                    trustedSourceTimestamps: { createdAt: 100, updatedAt: 201 },
                });

                expect(currentTx.sessionMessage.update).toHaveBeenCalledWith({
                    where: { id: "m-history", rowRevision: BigInt(0) },
                    data: { sourceUpdatedAt: new Date(201), rowRevision: { increment: BigInt(1) } },
                    select: expect.any(Object),
                });
                expect(advanced).toMatchObject({
                    ok: true,
                    didWrite: false,
                    didUpdate: false,
                    badgeAttentionChanged: false,
                    participantCursors: [],
                    message: { sourceUpdatedAt: new Date(201) },
                });
                expect(markAccountChanged).not.toHaveBeenCalled();

                arrangePath(watermarked);
                const staleContent = await createSessionMessage({
                    ...base,
                    content: { t: "plain", v: { role: "agent", content: { type: "text", text: "stale-different" } } },
                    trustedSourceTimestamps: { createdAt: 100, updatedAt: 200 },
                });

                expect(staleContent).toEqual({ ok: false, error: "invalid-params" });
                expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
                expect(markAccountChanged).not.toHaveBeenCalled();
            },
        );

        it("re-evaluates a trusted watermark after its row-revision CAS loses", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const committedFence = new Date(10);
            const session = {
                accountId: "u1",
                tag: "session",
                encryptionMode: "plain",
                currentStorageState: "hosted",
                shares: [],
                active: true,
                archivedAt: null,
                lastActiveAt: committedFence,
                updatedAt: new Date(20),
            };
            const stale = {
                id: "m-trusted-revision-race",
                seq: 4,
                localId: "trusted-revision-race",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "same" } } } as const,
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(200),
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                rowRevision: BigInt(0),
                createdAt: new Date(300),
                updatedAt: new Date(300),
            };
            const reRead = { ...stale, rowRevision: BigInt(1), updatedAt: new Date(301) };
            const advanced = {
                ...reRead,
                sourceUpdatedAt: new Date(201),
                rowRevision: BigInt(2),
                updatedAt: new Date(302),
            };

            currentTx.session.findUnique.mockResolvedValue(session);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.findUnique
                .mockResolvedValueOnce(stale)
                .mockResolvedValueOnce(reRead);
            currentTx.sessionMessage.update
                .mockRejectedValueOnce({ code: "P2025" })
                .mockResolvedValueOnce(advanced);

            const result = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "trusted-revision-race",
                content: stale.content,
                messageRole: "agent",
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 201 },
                trustedTranscriptObservationProvenance: { kind: "non_dependent", source: "history" },
            });

            expect(result).toMatchObject({
                ok: true,
                didWrite: false,
                didUpdate: false,
                message: { sourceUpdatedAt: new Date(201) },
            });
            if (!result.ok) throw new Error("expected row-revision retry to succeed");
            expect(Object.prototype.hasOwnProperty.call(result.message, "rowRevision")).toBe(false);

            expect(currentTx.sessionMessage.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
                where: { id: stale.id, rowRevision: BigInt(0) },
            }));
            expect(currentTx.sessionMessage.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
                where: { id: stale.id, rowRevision: BigInt(1) },
            }));
        });

        it("revalidates publisher authority before retrying a lost trusted row-revision CAS", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const committedFence = new Date(10);
            const session = {
                accountId: "u1",
                tag: "session",
                encryptionMode: "plain",
                currentStorageState: "hosted",
                shares: [],
                active: true,
                archivedAt: null,
                lastActiveAt: committedFence,
                updatedAt: new Date(20),
            };
            const existing = {
                id: "m-trusted-revision-authority",
                seq: 4,
                localId: "trusted-revision-authority",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", content: { type: "text", text: "same" } } } as const,
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(200),
                transcriptObservationProvenance: {
                    kind: "non_dependent",
                    source: "history",
                } satisfies SessionTranscriptObservationProvenanceV1,
                rowRevision: BigInt(0),
                createdAt: new Date(300),
                updatedAt: new Date(300),
            };

            currentTx.session.findUnique.mockResolvedValue(session);
            currentTx.session.updateMany
                .mockResolvedValueOnce({ count: 1 })
                .mockResolvedValueOnce({ count: 0 });
            currentTx.sessionMessage.findUnique.mockResolvedValue(existing);
            currentTx.sessionMessage.update.mockRejectedValueOnce({ code: "P2025" });

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: existing.localId,
                content: existing.content,
                messageRole: "agent",
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 201 },
                trustedTranscriptObservationProvenance: existing.transcriptObservationProvenance,
            })).resolves.toEqual({ ok: false, error: "forbidden" });

            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(2);
            expect(currentTx.sessionMessage.findUnique).toHaveBeenCalledTimes(1);
            expect(currentTx.sessionMessage.update).toHaveBeenCalledTimes(1);
        });

        it("rejects a trusted local-id retry that changes an established role", async () => {
            const committedFence = new Date(10);
            const existing = {
                id: "m-trusted-role-conflict",
                seq: 4,
                localId: "trusted-role-conflict",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "encrypted" as const, c: "cipher" },
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(200),
                transcriptObservationProvenance: { kind: "non_dependent" as const, source: "history" as const },
                createdAt: new Date(300),
                updatedAt: new Date(300),
            };
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    runtimeActivityRevision: BigInt(1),
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    currentStorageState: "hosted",
                    shares: [],
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.findUnique.mockResolvedValue(existing);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: existing.localId,
                messageRole: "user",
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 200 },
                trustedTranscriptObservationProvenance: existing.transcriptObservationProvenance,
            })).resolves.toEqual({
                ok: false,
                error: "invalid-params",
                code: "session_message_role_conflict",
            });

            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("publishes one trusted local-id role backfill while keeping watermark-only retries silent", async () => {
            const committedFence = new Date(10);
            const existing = {
                id: "m-trusted-role-backfill",
                seq: 4,
                localId: "trusted-role-backfill",
                sidechainId: null,
                messageRole: null,
                rowRevision: BigInt(0),
                content: { t: "encrypted" as const, c: "cipher" },
                sourceCreatedAt: new Date(100),
                sourceUpdatedAt: new Date(200),
                transcriptObservationProvenance: { kind: "non_dependent" as const, source: "history" as const },
                createdAt: new Date(300),
                updatedAt: new Date(300),
            };
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    runtimeActivityRevision: BigInt(1),
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    currentStorageState: "hosted",
                    shares: [],
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce(hostedTranscriptPublication())
                .mockResolvedValueOnce(hostedTranscriptPublication());
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.findUnique.mockResolvedValue(existing);
            currentTx.sessionMessage.update.mockResolvedValue({ ...existing, messageRole: "agent" });
            markAccountChanged.mockResolvedValueOnce(101);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: existing.localId,
                messageRole: "agent",
                publisherAuthority: { accountId: "u1", machineId: "machine-1", sessionId: "s1", committedFence },
                trustedSourceTimestamps: { createdAt: 100, updatedAt: 200 },
                trustedTranscriptObservationProvenance: existing.transcriptObservationProvenance,
            })).resolves.toMatchObject({
                ok: true,
                didWrite: false,
                didUpdate: true,
                badgeAttentionChanged: false,
                participantCursors: [{ accountId: "u1", cursor: 101 }],
            });

            expect(currentTx.sessionMessage.update).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: existing.id, rowRevision: BigInt(0) },
                data: { messageRole: "agent", rowRevision: { increment: BigInt(1) } },
            }));
            expect(markAccountChanged).toHaveBeenCalledTimes(1);
        });

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
                rowRevision: BigInt(0),
                content: { t: "encrypted", c: "c1" },
                createdAt: new Date(1),
                updatedAt: new Date(2),
            });
            currentTx.sessionMessage.findUnique.mockResolvedValue({
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
                where: { id: "s1", currentStorageState: "hosted" },
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

        it("does not mutate a P2002 collision after shared edit access is revoked", async () => {
            const session = {
                accountId: "owner",
                encryptionMode: "e2ee",
                currentStorageState: "hosted",
                shares: [{ sharedWithUserId: "editor" }],
                active: true,
                archivedAt: null,
            };
            const staleWinner = {
                id: "m-revoked-access",
                seq: 4,
                localId: "revoked-access",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted" as const, c: "previous" },
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                transcriptObservationProvenance: null,
                createdAt: new Date(1),
                updatedAt: new Date(2),
            };

            currentTx.session.findUnique.mockResolvedValue(session);
            currentTx.sessionShare.findUnique
                .mockResolvedValueOnce({ accessLevel: "edit" })
                .mockResolvedValueOnce(null);
            currentTx.session.update.mockResolvedValue({ seq: 5 });
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: { target: ["sessionId", "localId"] },
            });
            currentTx.sessionMessage.update.mockResolvedValue({ ...staleWinner, content: { t: "encrypted", c: "next" } });
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            dbMocks.db.session.findUnique.mockResolvedValue(session);
            dbMocks.db.sessionShare.findUnique.mockResolvedValue({ accessLevel: "edit" });
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue(staleWinner);

            await expect(createSessionMessage({
                actorUserId: "editor",
                sessionId: "s1",
                ciphertext: "next",
                localId: staleWinner.localId,
                messageRole: "user",
            })).resolves.toEqual({ ok: false, error: "forbidden" });

            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("does not update a stale P2002 collision winner outside its recovery transaction", async () => {
            const session = {
                accountId: "u1",
                encryptionMode: "e2ee",
                currentStorageState: "hosted",
                shares: [],
                active: true,
                archivedAt: null,
            };
            const staleWinner = {
                id: "m-winner-moved",
                seq: 4,
                localId: "winner-moved",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted" as const, c: "previous" },
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                transcriptObservationProvenance: null,
                createdAt: new Date(1),
                updatedAt: new Date(2),
            };
            const movedWinner = { ...staleWinner, sidechainId: "sidechain-moved" };

            currentTx.session.findUnique.mockResolvedValue(session);
            currentTx.session.update.mockResolvedValue({ seq: 5 });
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: { target: ["sessionId", "localId"] },
            });
            currentTx.sessionMessage.findUnique.mockResolvedValue(movedWinner);
            currentTx.sessionMessage.update.mockResolvedValue({ ...staleWinner, content: { t: "encrypted", c: "next" } });
            markAccountChanged.mockResolvedValueOnce(101);

            dbMocks.db.session.findUnique.mockResolvedValue(session);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue(staleWinner);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "next",
                localId: staleWinner.localId,
                messageRole: "user",
            })).resolves.toEqual({ ok: false, error: "invalid-params" });

            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects a P2002 collision that changes an established role", async () => {
            const session = {
                accountId: "u1",
                encryptionMode: "e2ee",
                currentStorageState: "hosted",
                shares: [],
                active: true,
                archivedAt: null,
            };
            const existing = {
                id: "m-role-conflict",
                seq: 4,
                localId: "role-conflict",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "encrypted" as const, c: "cipher" },
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                transcriptObservationProvenance: null,
                createdAt: new Date(1),
                updatedAt: new Date(2),
            };

            currentTx.session.findUnique.mockResolvedValue(session);
            currentTx.session.update.mockResolvedValue({ seq: 5 });
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: { target: ["sessionId", "localId"] },
            });
            currentTx.sessionMessage.findUnique.mockResolvedValue(existing);
            dbMocks.db.session.findUnique.mockResolvedValue(session);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue(existing);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: existing.localId,
                messageRole: "user",
            })).resolves.toEqual({
                ok: false,
                error: "invalid-params",
                code: "session_message_role_conflict",
            });

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
            currentTx.sessionMessage.findUnique.mockResolvedValue({
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

        it("preserves Voice History no-attention when a concurrent insert wins and the duplicate reconciles a correction", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");
            const voiceHistorySession = {
                accountId: "u1",
                tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
                encryptionMode: "e2ee",
                currentStorageState: "hosted",
                shares: [],
            };

            currentTx.session.findUnique.mockResolvedValue(voiceHistorySession);
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: { target: ["sessionId", "localId"] },
            });

            dbMocks.db.session.findUnique.mockResolvedValue(voiceHistorySession);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue({
                id: "m-voice-history",
                seq: 4,
                localId: "voice-history-final",
                sidechainId: null,
                messageRole: "agent",
                rowRevision: BigInt(0),
                content: { t: "encrypted", c: "previous" },
                createdAt,
                updatedAt,
            });
            currentTx.sessionMessage.findUnique.mockResolvedValue({
                id: "m-voice-history",
                seq: 4,
                localId: "voice-history-final",
                sidechainId: null,
                messageRole: "agent",
                rowRevision: BigInt(0),
                content: { t: "encrypted", c: "previous" },
                createdAt,
                updatedAt,
            });

            currentTx.sessionMessage.update.mockResolvedValue({
                id: "m-voice-history",
                seq: 4,
                localId: "voice-history-final",
                sidechainId: null,
                messageRole: "agent",
                rowRevision: BigInt(1),
                content: { t: "encrypted", c: "corrected" },
                createdAt,
                updatedAt,
            });
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "voice-history",
                ciphertext: "corrected",
                localId: "voice-history-final",
                messageRole: "agent",
            });

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                didUpdate: true,
                badgeAttentionChanged: false,
                attentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
                message: expect.objectContaining({
                    id: "m-voice-history",
                    seq: 4,
                    localId: "voice-history-final",
                }),
                participantCursors: [
                    { accountId: "u1", cursor: 101 },
                ],
            });
            expect(currentTx.sessionMessage.update).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: "m-voice-history", rowRevision: BigInt(0) },
                data: {
                    content: { t: "encrypted", c: "corrected" },
                    sidechainId: null,
                    messageRole: "agent",
                    rowRevision: { increment: BigInt(1) },
                },
            }));
        });

        it("updates existing message content for (sessionId, localId) when payload changes", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique.mockResolvedValue({
                accountId: "u1",
                currentStorageState: "hosted",
                shares: [{ sharedWithUserId: "u2" }],
            });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({ code: "P2002" });

            dbMocks.db.session.findUnique.mockResolvedValue({
                accountId: "u1",
                currentStorageState: "hosted",
                shares: [{ sharedWithUserId: "u2" }],
            });
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                rowRevision: BigInt(0),
                content: { t: "encrypted", c: "prev" },
                createdAt,
                updatedAt,
            });
            currentTx.sessionMessage.findUnique.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                rowRevision: BigInt(0),
                content: { t: "encrypted", c: "prev" },
                createdAt,
                updatedAt,
            });

            currentTx.sessionMessage.update.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                rowRevision: BigInt(1),
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
                attentionImpact: {
                    affectsUnread: true,
                    affectsMeaningfulActivity: true,
                },
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
                    where: { id: "m1", rowRevision: BigInt(0) },
                    data: {
                        content: { t: "encrypted", c: "next" },
                        sidechainId: null,
                        messageRole: null,
                        rowRevision: { increment: BigInt(1) },
                    },
                }),
            );
            expect(getSessionParticipantUserIds).not.toHaveBeenCalled();
        });

        it("replays an exact immutable divider P2002 winner without rewriting it", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");
            const winner = {
                id: "m-immutable-divider-winner",
                seq: 4,
                localId: "agent-transition:submitted-1",
                sidechainId: null,
                rowRevision: BigInt(0),
                messageRole: "event",
                content: { t: "encrypted" as const, c: "same" },
                createdAt,
                updatedAt,
            };

            currentTx.session.findUnique.mockResolvedValue({
                accountId: "u1",
                currentStorageState: "hosted",
                shares: [{ sharedWithUserId: "u2" }],
            });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: { target: ["sessionId", "localId"] },
            });
            currentTx.sessionMessage.findUnique.mockResolvedValue(winner);
            dbMocks.db.session.findUnique.mockResolvedValue({
                accountId: "u1",
                currentStorageState: "hosted",
                shares: [{ sharedWithUserId: "u2" }],
            });
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue(winner);

            const result = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "same",
                localId: winner.localId,
                messageRole: "event",
                localIdConflictPolicy: "identical-or-conflict",
            });

            expect(result).toEqual({
                ok: true,
                didWrite: false,
                didUpdate: false,
                badgeAttentionChanged: false,
                message: {
                    id: winner.id,
                    seq: winner.seq,
                    localId: winner.localId,
                    sidechainId: null,
                    messageRole: "event",
                    content: winner.content,
                    createdAt,
                    updatedAt,
                },
                participantCursors: [],
            });
            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("returns an immutable local-ID conflict instead of correcting a P2002 winner", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");
            const winner = {
                id: "m-immutable-winner",
                seq: 4,
                localId: "immutable-local-id",
                sidechainId: null,
                rowRevision: BigInt(0),
                messageRole: "event",
                content: { t: "encrypted" as const, c: "winner" },
                createdAt,
                updatedAt,
            };

            currentTx.session.findUnique.mockResolvedValue({
                accountId: "u1",
                currentStorageState: "hosted",
                shares: [{ sharedWithUserId: "u2" }],
            });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: { target: ["sessionId", "localId"] },
            });
            currentTx.sessionMessage.findUnique.mockResolvedValue(winner);
            currentTx.sessionMessage.update.mockResolvedValue({
                ...winner,
                rowRevision: BigInt(1),
                content: { t: "encrypted", c: "loser" },
            });
            dbMocks.db.session.findUnique.mockResolvedValue({
                accountId: "u1",
                currentStorageState: "hosted",
                shares: [{ sharedWithUserId: "u2" }],
            });
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue(winner);
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const params = {
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "loser",
                localId: winner.localId,
                messageRole: "event",
                localIdConflictPolicy: "identical-or-conflict" as const,
            } as Parameters<typeof createSessionMessage>[0] & Readonly<{
                localIdConflictPolicy: "identical-or-conflict";
            }>;
            const result = await createSessionMessage(params);

            expect(result).toEqual({ ok: false, error: "local-id-conflict" });
            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("re-evaluates an ordinary local-id correction after its row-revision CAS loses", async () => {
            const initial = {
                t: "encrypted" as const,
                c: "initial",
            };
            const corrected = {
                t: "encrypted" as const,
                c: "corrected",
            };
            const session = {
                accountId: "u1",
                tag: "session",
                encryptionMode: "e2ee",
                currentStorageState: "hosted",
                shares: [],
                active: true,
                archivedAt: null,
            };
            const stale = {
                id: "m-ordinary-revision-race",
                seq: 4,
                localId: "ordinary-revision-race",
                sidechainId: null,
                messageRole: null,
                content: initial,
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                transcriptObservationProvenance: null,
                rowRevision: BigInt(0),
                createdAt: new Date(1),
                updatedAt: new Date(2),
            };
            const reRead = {
                ...stale,
                content: corrected,
                messageRole: "user",
                rowRevision: BigInt(1),
                updatedAt: new Date(3),
            };
            const winningCorrection = {
                ...stale,
                messageRole: "agent",
                rowRevision: BigInt(2),
                updatedAt: new Date(4),
            };

            currentTx.session.findUnique.mockResolvedValue(session);
            currentTx.session.update.mockResolvedValue({ seq: 5 });
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: { target: ["sessionId", "localId"] },
            });
            currentTx.sessionMessage.findUnique
                .mockResolvedValueOnce(stale)
                .mockResolvedValueOnce(reRead);
            currentTx.sessionMessage.update
                .mockRejectedValueOnce({ code: "P2025" })
                .mockResolvedValueOnce(winningCorrection);
            markAccountChanged.mockResolvedValueOnce(101);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: initial.c,
                localId: stale.localId,
                messageRole: "agent",
            })).resolves.toMatchObject({
                ok: true,
                didWrite: false,
                didUpdate: true,
                message: {
                    content: initial,
                    messageRole: "agent",
                },
            });

            expect(currentTx.sessionMessage.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
                where: { id: stale.id, rowRevision: BigInt(0) },
            }));
            expect(currentTx.sessionMessage.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
                where: { id: stale.id, rowRevision: BigInt(1) },
            }));
        });

        it("does not mutate a local-id collision winner after hosted write authority changes", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const initialHostedSession = {
                accountId: "u1",
                encryptionMode: "plain",
                shares: [],
                active: true,
                archivedAt: null,
            };
            const content = {
                t: "plain" as const,
                v: { role: "user", content: { type: "text", text: "collision correction" } },
            };
            const existing = {
                id: "m-collision-authority",
                seq: 4,
                localId: "collision-authority",
                sidechainId: null,
                messageRole: "user",
                content: {
                    t: "plain" as const,
                    v: { role: "user", content: { type: "text", text: "winner" } },
                },
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                transcriptObservationProvenance: null,
                createdAt: new Date(1),
                updatedAt: new Date(2),
            };

            currentTx.session.findUnique.mockImplementation(async (args: { select?: unknown }) => {
                const select = args.select;
                if (
                    select
                    && typeof select === "object"
                    && Object.keys(select).length === 1
                    && "currentStorageState" in select
                ) {
                    return { currentStorageState: "machine_only" };
                }
                return initialHostedSession;
            });
            currentTx.session.update.mockResolvedValue({ seq: 5 });
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: { target: ["sessionId", "localId"] },
            });

            dbMocks.db.session.findUnique.mockResolvedValue({
                ...initialHostedSession,
                currentStorageState: "machine_only",
            });
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue(existing);
            currentTx.sessionMessage.findUnique.mockResolvedValue(existing);
            currentTx.sessionMessage.update.mockResolvedValue({ ...existing, content });
            markAccountChanged.mockResolvedValueOnce(101);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                content,
                localId: "collision-authority",
                messageRole: "user",
            })).resolves.toEqual({
                ok: false,
                error: "invalid-params",
                code: "session_storage_authority_mismatch",
            });

            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("backfills a duplicate role with one private row-revision increment", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");
            const session = {
                accountId: "u1",
                encryptionMode: "e2ee",
                currentStorageState: "hosted",
                shares: [],
                active: true,
                archivedAt: null,
            };
            const existing = {
                id: "m-role",
                seq: 4,
                localId: "role-backfill",
                sidechainId: null,
                messageRole: null,
                content: { t: "encrypted" as const, c: "cipher" },
                createdAt,
                updatedAt,
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                transcriptObservationProvenance: null,
                rowRevision: BigInt(0),
            };

            currentTx.session.findUnique.mockResolvedValue(session);
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            dbMocks.db.session.findUnique.mockResolvedValue(session);
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue(existing);
            currentTx.sessionMessage.findUnique.mockResolvedValue(existing);
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: { target: ["sessionId", "localId"] },
            });
            currentTx.sessionMessage.update.mockResolvedValue({ ...existing, messageRole: "agent" });
            markAccountChanged.mockResolvedValueOnce(101);

            await expect(createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "role-backfill",
                messageRole: "agent",
            })).resolves.toMatchObject({
                ok: true,
                didWrite: false,
                didUpdate: true,
                badgeAttentionChanged: false,
                participantCursors: [{ accountId: "u1", cursor: 101 }],
            });

            expect(currentTx.sessionMessage.update).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: "m-role", rowRevision: BigInt(0) },
                data: { messageRole: "agent", rowRevision: { increment: BigInt(1) } },
            }));
            expect(markAccountChanged).toHaveBeenCalledTimes(1);
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
                // `ensureSessionEditAccess` reads the activity-badge inputs, so the
                // pre-write badge contribution is derived from THIS row.
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [{ sharedWithUserId: "u2" }],
                    currentStorageState: "hosted",
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    currentStorageState: "hosted",
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
                rowRevision: BigInt(0),
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
            expect(currentTx.session.findUnique).toHaveBeenCalledTimes(2);
            expect(currentTx.sessionMessage.findUnique).not.toHaveBeenCalled();
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
        });

        it("does not make a non-unread system message create unread activity when the session was already read", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                shares: [],
                seq: 9,
                lastViewedSessionSeq: 9,
                pendingCount: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnStatus: null,
                lastRuntimeIssue: null,
                active: true,
                archivedAt: null,
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-auth",
                seq: 10,
                localId: "auth-event",
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
                content: { t: "encrypted", c: "cipher" },
                localId: "auth-event",
                messageRole: "event",
                trustedAttentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(res.badgeAttentionChanged).toBe(false);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 10 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 10 },
            });
            expect(currentTx.session.update).toHaveBeenNthCalledWith(1, {
                where: { id: "s1", currentStorageState: "hosted" },
                select: { seq: true },
                data: { seq: { increment: 1 } },
            });
            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
        });

        it("keeps hosted Voice transcript-history messages out of unread and meaningful activity", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                tag: "system:voice-transcript-history:v1",
                encryptionMode: "e2ee",
                shares: [],
                seq: 9,
                lastViewedSessionSeq: null,
                pendingCount: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnStatus: null,
                lastRuntimeIssue: null,
                active: false,
                archivedAt: null,
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-voice-history",
                seq: 10,
                localId: "voice-history-final",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "voice-history",
                content: { t: "encrypted", c: "cipher" },
                localId: "voice-history-final",
                messageRole: "agent",
            });

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.attentionImpact).toEqual({
                affectsUnread: false,
                affectsMeaningfulActivity: false,
            });
            expect(res.badgeAttentionChanged).toBe(false);
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "voice-history",
                    OR: [{ lastViewedSessionSeq: { lt: 10 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 10 },
            });
        });

        it("derives non-unread attention for owner-authored encrypted maintenance event local ids", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                encryptionMode: "e2ee",
                shares: [],
                seq: 9,
                lastViewedSessionSeq: 9,
                pendingCount: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnStatus: null,
                lastRuntimeIssue: null,
                active: true,
                archivedAt: null,
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-quota",
                seq: 10,
                localId: "agent-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted",
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
                content: { t: "encrypted", c: "cipher" },
                localId: "agent-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted",
                messageRole: "event",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(res.badgeAttentionChanged).toBe(false);
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 10 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 10 },
            });
        });

        it("derives non-unread attention for owner-authored plaintext maintenance events", async () => {
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const content = {
                t: "plain",
                v: {
                    role: "agent",
                    content: {
                        type: "event",
                        id: "quota-wait-event",
                        data: {
                            type: "agent-quota-wait",
                            serviceId: "openai-codex",
                            groupId: "main",
                            resetAtMs: 1_900_000,
                            reason: "connected_service_group_quota_exhausted",
                        },
                    },
                },
            } satisfies PrismaJson.SessionMessageContent;

            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                encryptionMode: "plain",
                shares: [],
                seq: 9,
                lastViewedSessionSeq: 9,
                pendingCount: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnStatus: null,
                lastRuntimeIssue: null,
                active: true,
                archivedAt: null,
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-quota-plain",
                seq: 10,
                localId: "agent-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted",
                sidechainId: null,
                messageRole: "event",
                content,
                createdAt,
                updatedAt: createdAt,
            });
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                content,
                localId: "agent-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted",
                messageRole: "event",
            });

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.badgeAttentionChanged).toBe(false);
            expect(res.attentionImpact).toEqual({
                affectsUnread: false,
                affectsMeaningfulActivity: false,
            });
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 10 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 10 },
            });
        });

        it("does not derive non-unread attention from maintenance local ids for shared editors", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                encryptionMode: "e2ee",
                shares: [{ sharedWithUserId: "u2" }],
                seq: 9,
                lastViewedSessionSeq: 9,
                pendingCount: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnStatus: null,
                lastRuntimeIssue: null,
                active: true,
                archivedAt: null,
            });
            currentTx.sessionShare.findUnique.mockResolvedValue({ accessLevel: "edit" });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-quota",
                seq: 10,
                localId: "agent-quota-recovered:quota-blocked_openai-codex_main:reset_at_1900000:fresh_quota_evidence",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "u2",
                sessionId: "s1",
                content: { t: "encrypted", c: "cipher" },
                localId: "agent-quota-recovered:quota-blocked_openai-codex_main:reset_at_1900000:fresh_quota_evidence",
                messageRole: "event",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", seq: 10 },
                data: { meaningfulActivityAt: createdAt },
            });
        });

        it("does not let a non-unread system message clear pre-existing unread activity", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                encryptionMode: "plain",
                shares: [],
                seq: 9,
                lastViewedSessionSeq: 7,
                pendingCount: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnStatus: null,
                lastRuntimeIssue: null,
                active: true,
                archivedAt: null,
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-auth",
                seq: 10,
                localId: "auth-event",
                sidechainId: null,
                messageRole: "event",
                content: { t: "plain", v: {
                    role: "agent",
                    content: {
                        type: "event",
                        id: "auth-event",
                        data: {
                            type: "connected-service-account-switch",
                            serviceId: "openai-codex",
                            groupId: "group-1",
                            fromProfileId: "profile-a",
                            toProfileId: "profile-b",
                            reason: "usage_limit",
                        },
                    },
                } },
                createdAt,
                updatedAt: createdAt,
            });
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                content: { t: "plain", v: {
                    role: "agent",
                    content: {
                        type: "event",
                        id: "auth-event",
                        data: {
                            type: "connected-service-account-switch",
                            serviceId: "openai-codex",
                            groupId: "group-1",
                            fromProfileId: "profile-a",
                            toProfileId: "profile-b",
                            reason: "usage_limit",
                        },
                    },
                } },
                localId: "auth-event",
                messageRole: "event",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(res.badgeAttentionChanged).toBe(false);
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
        });

        it("keeps auto-advanced non-unread read cursors monotonic when a concurrent writer already moved them ahead", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [],
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce(hostedTranscriptPublication())
                .mockResolvedValueOnce({
                    lastViewedSessionSeq: 12,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-auth",
                seq: 10,
                localId: "auth-event",
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
                content: { t: "encrypted", c: "cipher" },
                localId: "auth-event",
                messageRole: "event",
                trustedAttentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(res.badgeAttentionChanged).toBe(false);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 10 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 10 },
            });
            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
            expect(currentTx.session.findUnique).toHaveBeenNthCalledWith(3, {
                where: { id: "s1" },
                select: { lastViewedSessionSeq: true },
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
                where: { id: "s1", currentStorageState: "hosted" },
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
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
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
                where: { id: "s1", currentStorageState: "hosted" },
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
                rowRevision: BigInt(0),
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt,
            });
            currentTx.sessionMessage.findUnique.mockResolvedValue({
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
        it("rejects layout-zero metadata edits from a non-owner editor", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "legacy-whole-bag",
                    seq: 0,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce({ accessLevel: "edit" });
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            markAccountChanged.mockResolvedValueOnce(10).mockResolvedValueOnce(11);

            const res = await updateSessionMetadata({
                actorUserId: "u2",
                sessionId: "s1",
                expectedVersion: 5,
                metadataCiphertext: "shared-editor-write",
            });

            expect(res).toEqual({
                ok: false,
                error: "forbidden",
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("still rejects a layout-zero metadata write from a view-only participant", async () => {
            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                encryptionMode: "e2ee",
                shares: [{ sharedWithUserId: "u2" }],
            });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce({ accessLevel: "view" });

            const res = await updateSessionMetadata({
                actorUserId: "u2",
                sessionId: "s1",
                expectedVersion: 5,
                metadataCiphertext: "unauthorized-write",
            });

            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("does not return legacy current metadata when layout activation wins the CAS race", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "legacy-whole-bag",
                    seq: 0,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    ownerMetadata: "owner-ciphertext",
                    metadataVersion: 6,
                    metadata: "shared-safe",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 5,
                metadataCiphertext: "stale-legacy-write",
            });

            expect(res).toEqual({
                ok: false,
                error: "metadata_privacy_upgrade_required",
            });
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("keeps semantically equal plaintext metadata at the current version without a write", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "{\"a\":1,\"b\":2}",
                    encryptionMode: "plain",
                    seq: 0,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 5,
                metadataCiphertext: "{\"b\":2,\"a\":1}",
            });

            expect(res).toEqual({
                ok: true,
                version: 5,
                metadata: "{\"a\":1,\"b\":2}",
                participantCursors: [],
                badgeAttentionChanged: false,
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("advances only the read cursor for a semantic metadata no-op using the layout fence", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "{\"a\":1,\"b\":2}",
                    encryptionMode: "plain",
                    seq: 9,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: 2,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 5,
                metadataCiphertext: "{\"b\":2,\"a\":1}",
                readCursorHintV1: { lastViewedSessionSeq: 8 },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    metadataVersion: 5,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                },
                data: { lastViewedSessionSeq: 8 },
            });
            expect(res).toEqual(expect.objectContaining({
                ok: true,
                version: 5,
                metadata: "{\"a\":1,\"b\":2}",
                lastViewedSessionSeq: 8,
            }));
        });

    });

    describe("updateSessionAgentState", () => {
        it("rejects layout-zero Agent-state edits from a non-owner admin", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    agentStateVersion: 5,
                    agentState: "legacy-agent-state",
                    seq: 0,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    pendingRequestObservedAt: null,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce({ accessLevel: "admin" });
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            markAccountChanged.mockResolvedValueOnce(10).mockResolvedValueOnce(11);

            const res = await updateSessionAgentState({
                actorUserId: "u2",
                sessionId: "s1",
                expectedVersion: 5,
                agentStateCiphertext: "shared-editor-write",
            });

            expect(res).toEqual({
                ok: false,
                error: "forbidden",
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("still rejects a layout-zero Agent-state write from an unshared participant", async () => {
            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                encryptionMode: "e2ee",
                shares: [],
            });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);

            const res = await updateSessionAgentState({
                actorUserId: "u2",
                sessionId: "s1",
                expectedVersion: 5,
                agentStateCiphertext: "unauthorized-write",
            });

            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("does not return legacy current Agent state when a partial split wins the CAS race", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    agentStateVersion: 1,
                    agentState: "legacy-state",
                    seq: 0,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: "partial-split-owner-ciphertext",
                    agentStateVersion: 2,
                    agentState: "private-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "stale-legacy-state",
            });

            expect(res).toEqual({
                ok: false,
                error: "metadata_privacy_upgrade_required",
            });
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("fences the owner Agent-state CAS writer", async () => {
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

            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("fences pending request projection writes carried by the legacy Agent-state writer", async () => {
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

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
        });

        it("fences stale pending request projections carried by the legacy Agent-state writer", async () => {
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
                    pendingRequestObservedAt: null,
                    latestTurnStatus: "failed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const params: Parameters<typeof updateSessionAgentState>[0] & { pendingRequestNewestCreatedAt: number } = {
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 1,
                pendingRequestNewestCreatedAt: 150,
            };
            const res = await updateSessionAgentState(params);

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
        });

        it("fences count-only pending request projections carried by the legacy Agent-state writer", async () => {
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
                    pendingRequestObservedAt: null,
                    latestTurnStatus: "failed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
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
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 1,
            });

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
        });

        it("fences fresh pending request projections carried by the legacy Agent-state writer", async () => {
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
                    pendingRequestObservedAt: null,
                    latestTurnStatus: "failed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const params: Parameters<typeof updateSessionAgentState>[0] & { pendingRequestNewestCreatedAt: number } = {
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestNewestCreatedAt: 250,
            };
            const res = await updateSessionAgentState(params);

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
        });

        it("fences runtime issue summary boundary input carried by the legacy Agent-state writer", async () => {
            const issue = {
                v: 1,
                scope: "primary_session",
                status: "failed",
                code: "agent_status_error",
                source: "agent_status_error",
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

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.findUnique).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).not.toHaveBeenCalled();
            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
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

        it("fences malformed runtime issue summary boundary input carried by the legacy Agent-state writer", async () => {
            const invalidRuntimeIssueSummaryV1: unknown = {
                latestTurnStatus: "failed",
                lastRuntimeIssue: {
                    v: 1,
                    scope: "primary_session",
                    status: "completed",
                    code: "agent_status_error",
                    source: "agent_status_error",
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

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.findUnique).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).not.toHaveBeenCalled();
            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
        });

        it("fences before the legacy Agent-state CAS retry path", async () => {
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

            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("fences before the legacy Agent-state CAS missing-row retry path", async () => {
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

            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
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
            agentId: "codex",
            agentTurnId: "provider-turn-1",
            status: "completed",
            startedAt: BigInt(100),
            updatedAt: BigInt(200),
            terminalAt: BigInt(200),
            lastRuntimeIssue: null,
            transcriptAnchorsJson: null,
            rollbackState: null,
            rollbackReason: null,
            agentRollbackOrdinal: null,
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
            agentTurnId: "provider-turn-1",
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
                })
                .mockResolvedValueOnce(hostedTranscriptPublication());
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.create.mockResolvedValue({
                id: "row-turn-1",
                sessionId: "s1",
                turnId: "turn-1",
                agentId: "codex",
                agentTurnId: null,
                status: "in_progress",
                startedAt: BigInt(100),
                updatedAt: BigInt(100),
                terminalAt: null,
                lastRuntimeIssue: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                agentRollbackOrdinal: null,
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
                    agentId: "codex",
                    status: "in_progress",
                    startedAt: BigInt(100),
                    updatedAt: BigInt(100),
                    transcriptAnchorProjectionVersion: 1,
                    transcriptAnchorMinSeq: null,
                    transcriptAnchorMaxSeq: null,
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

        it("persists transcript anchors and their query projection when beginning a turn", async () => {
            const transcriptAnchors = {
                startUserMessageSeq: 14,
                userMessageSeqs: [14, 16],
                startSeqInclusive: 13,
                endSeqInclusive: 21,
                finalAssistantMessageSeq: 20,
            } as const;
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
                })
                .mockResolvedValueOnce(hostedTranscriptPublication());
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.create.mockResolvedValue({
                id: "row-turn-1",
                sessionId: "s1",
                turnId: "turn-1",
                agentId: "codex",
                agentTurnId: null,
                status: "in_progress",
                startedAt: BigInt(100),
                updatedAt: BigInt(100),
                terminalAt: null,
                lastRuntimeIssue: null,
                transcriptAnchorsJson: JSON.stringify(transcriptAnchors),
                rollbackState: null,
                rollbackReason: null,
                agentRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-begin-anchored",
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...beginMutation,
                    mutationId: "mutation-begin-anchored",
                    transcriptAnchors,
                },
            });

            expect(currentTx.sessionTurn.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    transcriptAnchorsJson: JSON.stringify(transcriptAnchors),
                    transcriptAnchorProjectionVersion: 1,
                    transcriptAnchorMinSeq: 13,
                    transcriptAnchorMaxSeq: 21,
                }),
            });
        });

        it("touches the current active turn and derives a tolerant anchor query projection", async () => {
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
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce(hostedTranscriptPublication());
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                ...completedTurnRow,
                status: "in_progress",
                terminalAt: null,
                updatedAt: BigInt(100),
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: "legacy-invalid-entry",
                    startSeqInclusive: 11,
                    userMessageSeqs: [4, "legacy-invalid-entry"],
                    endSeqInclusive: null,
                    finalAssistantMessageSeq: 19,
                }),
                lastMutationId: "mutation-begin",
            });
            currentTx.sessionTurn.update.mockResolvedValue({
                ...completedTurnRow,
                status: "in_progress",
                terminalAt: null,
                updatedAt: BigInt(250),
                lastRuntimeIssueJson: null,
                lastMutationId: "mutation-touch",
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(251);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-touch",
                    turnId: "turn-1",
                    action: "touch_active",
                    provider: "codex",
                    agentTurnId: "provider-turn-1",
                    observedAt: 250,
                },
            });

            expect(currentTx.sessionTurn.update).toHaveBeenCalledWith({
                where: { id: "row-turn-1" },
                data: expect.objectContaining({
                    status: "in_progress",
                    updatedAt: BigInt(250),
                    transcriptAnchorProjectionVersion: 1,
                    transcriptAnchorMinSeq: 4,
                    transcriptAnchorMaxSeq: 19,
                    lastMutationId: "mutation-touch",
                }),
            });
            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: {
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(250),
                    lastRuntimeIssue: null,
                    thinking: true,
                    thinkingAt: new Date(250),
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 250,
                lastRuntimeIssue: null,
                participantCursors: [{ accountId: "u1", cursor: 251 }],
            });
        });

        it("sanitizes usage-limit runtime issue metadata before persisting a failed turn", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            const unsafeIssue = {
                v: 1,
                scope: "primary_session",
                status: "failed",
                code: "usage_limit",
                source: "usage_limit",
                occurredAt: 250,
                provider: "codex",
                sanitizedPreview: "Usage limit reached",
                usageLimit: {
                    v: 1,
                    resetAtMs: null,
                    retryAfterMs: null,
                    quotaScope: "account",
                    recoverability: "wait",
                    providerLimitId: "Bearer secret-provider-limit-token",
                    planType: "enterprise secret plan",
                    action: {
                        kind: "open_url",
                        url: "https://provider.example/usage?access_token=secret#fragment",
                    },
                },
            } as const;

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
                updatedAt: BigInt(100),
                lastRuntimeIssueJson: null,
                lastMutationId: "mutation-begin",
            });
            currentTx.sessionTurn.update.mockResolvedValue({
                ...completedTurnRow,
                status: "failed",
                updatedAt: BigInt(250),
                terminalAt: BigInt(250),
                lastRuntimeIssueJson: JSON.stringify({
                    ...unsafeIssue,
                    usageLimit: {
                        v: 1,
                        resetAtMs: null,
                        retryAfterMs: null,
                        quotaScope: "account",
                        recoverability: "wait",
                        planType: null,
                    },
                }),
                lastMutationId: "mutation-fail",
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(251);

            await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-fail",
                    turnId: "turn-1",
                    action: "fail",
                    provider: "codex",
                    observedAt: 250,
                    issue: unsafeIssue,
                },
            });

            const turnUpdateData = currentTx.sessionTurn.update.mock.calls[0]?.[0]?.data;
            const sessionUpdateData = currentTx.session.update.mock.calls[0]?.[0]?.data;
            const persistedTurnIssue = JSON.parse(turnUpdateData.lastRuntimeIssueJson);
            const persistedSessionIssue = JSON.parse(sessionUpdateData.lastRuntimeIssue);
            expect(persistedTurnIssue.usageLimit).toMatchObject({
                v: 1,
                resetAtMs: null,
                retryAfterMs: null,
                quotaScope: "account",
                recoverability: "wait",
                planType: null,
            });
            expect(persistedTurnIssue.usageLimit).not.toHaveProperty("providerLimitId");
            expect(persistedTurnIssue.usageLimit).not.toHaveProperty("action");
            expect(persistedSessionIssue.usageLimit).not.toHaveProperty("providerLimitId");
            expect(persistedSessionIssue.usageLimit).not.toHaveProperty("action");
        });

        it("clears pending request projections when materializing a terminal turn", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            const issue = {
                v: 1,
                scope: "primary_session",
                status: "failed",
                code: "opencode_prompt_submission_failed",
                source: "agent_session_error",
                occurredAt: 250,
                provider: "opencode",
                sanitizedPreview: "Error: TypeError: fetch failed",
            } as const;

            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 1,
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
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 1,
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
                updatedAt: BigInt(100),
                lastRuntimeIssueJson: null,
                lastMutationId: "mutation-begin",
            });
            currentTx.sessionTurn.update.mockResolvedValue({
                ...completedTurnRow,
                status: "failed",
                updatedAt: BigInt(250),
                terminalAt: BigInt(250),
                lastRuntimeIssueJson: JSON.stringify(issue),
                lastMutationId: "mutation-fail",
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(251);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-fail",
                    turnId: "turn-1",
                    action: "fail",
                    provider: "opencode",
                    observedAt: 250,
                    issue,
                },
            });

            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: expect.objectContaining({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "failed",
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    pendingRequestObservedAt: null,
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnStatus: "failed",
            });
        });

        it("ignores out-of-order active touches that would move in-progress freshness backwards", async () => {
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
                    latestTurnStatusObservedAt: BigInt(500),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(500),
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
                updatedAt: BigInt(500),
                lastRuntimeIssueJson: null,
                lastMutationId: "mutation-touch-newer",
            });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-touch-older",
                    turnId: "turn-1",
                    action: "touch_active",
                    provider: "codex",
                    observedAt: 450,
                },
            });

            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    sessionId: "s1",
                    mutationId: "mutation-touch-older",
                    turnId: "turn-1",
                    action: "touch_active",
                    decision: "stale-in-progress",
                    observedAt: BigInt(450),
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "stale-in-progress",
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 500,
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
                    agentTurnId: "provider-turn-1",
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

        it("returns the persisted receipt for duplicate mutation replays", async () => {
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
                    latestTurnId: "turn-later",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(900),
                    lastRuntimeIssueJson: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-later",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(900),
                    lastRuntimeIssue: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue({
                id: "receipt-1",
                sessionId: "s1",
                mutationId: "mutation-replayed",
                turnId: null,
                action: "end_session",
                decision: "missing-turn",
                observedAt: BigInt(111),
                appliedAt: BigInt(222),
            });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...beginMutation,
                    mutationId: "mutation-replayed",
                    action: "complete",
                    agentTurnId: "provider-turn-later",
                    observedAt: 999,
                },
            });

            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.update).not.toHaveBeenCalled();
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "duplicate-mutation",
                latestTurnId: "turn-later",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 900,
                receipt: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-replayed",
                    action: "end_session",
                    decision: "missing-turn",
                    observedAt: 111,
                    appliedAt: 222,
                },
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
                agentId: "codex",
                agentTurnId: "provider-turn-1",
                status: "in_progress",
                startedAt: BigInt(100),
                updatedAt: BigInt(100),
                terminalAt: null,
                lastRuntimeIssue: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                agentRollbackOrdinal: null,
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
                    agentTurnId: "provider-turn-1",
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

        it("lets newer same-context begin evidence clear a failed runtime issue and merge anchors", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            const retainedTranscriptAnchors = {
                startUserMessageSeq: 3,
                userMessageSeqs: [3, 5],
                startSeqInclusive: 2,
                endSeqInclusive: 8,
                finalAssistantMessageSeq: 7,
            } as const;
            const beginTranscriptAnchors = {
                userMessageSeqs: [5, 11],
                endSeqInclusive: 12,
                finalAssistantMessageSeq: 11,
            } as const;
            const mergedTranscriptAnchors = {
                startUserMessageSeq: 3,
                userMessageSeqs: [3, 5, 11],
                startSeqInclusive: 2,
                endSeqInclusive: 12,
                finalAssistantMessageSeq: 11,
            } as const;
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
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                ...failedUsageLimitTurnRow,
                transcriptAnchorsJson: JSON.stringify(retainedTranscriptAnchors),
            });
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
                    agentTurnId: "provider-turn-1",
                    observedAt: 300,
                    transcriptAnchors: beginTranscriptAnchors,
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
                    transcriptAnchorsJson: JSON.stringify(mergedTranscriptAnchors),
                    transcriptAnchorProjectionVersion: 1,
                    transcriptAnchorMinSeq: 2,
                    transcriptAnchorMaxSeq: 12,
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
                    agentTurnId: "provider-turn-1",
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

        it("persists a bounded provider checkpoint with rollback eligibility without changing lifecycle status", async () => {
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
                agentRollbackOrdinal: 4,
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
                    agentRollbackOrdinal: 4,
                    transcriptAnchors: {
                        providerCheckpoint: {
                            kind: "grok_prompt_index",
                            promptIndex: 3,
                        },
                    },
                    observedAt: 300,
                },
            });

            expect(res).not.toHaveProperty("reason");
            expect(res).toMatchObject({ ok: true, didApply: true });
            expect(currentTx.sessionTurn.update).toHaveBeenCalledWith({
                where: { id: "row-turn-1" },
                data: expect.objectContaining({
                    status: "completed",
                    rollbackState: "eligible",
                    agentRollbackOrdinal: 4,
                    transcriptAnchorsJson: JSON.stringify({
                        startUserMessageSeq: 1,
                        endSeqInclusive: 10,
                        providerCheckpoint: {
                            kind: "grok_prompt_index",
                            promptIndex: 3,
                        },
                    }),
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
                    agentRollbackOrdinal: 4,
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
            expect(updateArg.data).toMatchObject({
                transcriptAnchorProjectionVersion: 1,
                transcriptAnchorMinSeq: 1,
                transcriptAnchorMaxSeq: 12,
            });
        });

        it("rejects a final assistant anchor outside the canonical turn transcript range", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 12,
                    pendingCount: 0,
                    lastViewedSessionSeq: 12,
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
                    seq: 12,
                    pendingCount: 0,
                    lastViewedSessionSeq: 12,
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
                    startSeqInclusive: 1,
                    endSeqInclusive: 10,
                    userMessageSeqs: [1],
                }),
            });

            const result = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-invalid-final-anchor",
                    turnId: "turn-1",
                    action: "complete",
                    transcriptAnchors: { finalAssistantMessageSeq: 11 },
                    observedAt: 200,
                },
            });

            expect(result).toEqual({ ok: false, error: "invalid-params" });
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();

            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1", encryptionMode: "e2ee", seq: 12,
                    pendingCount: 0, lastViewedSessionSeq: 12,
                    pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1", latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100), lastRuntimeIssue: null,
                    active: true, archivedAt: null, shares: [],
                })
                .mockResolvedValueOnce({
                    seq: 12, pendingCount: 0, lastViewedSessionSeq: 12,
                    pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1", latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100), lastRuntimeIssue: null,
                    active: true, archivedAt: null,
                });
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                ...completedTurnRow,
                status: "in_progress",
                terminalAt: null,
                transcriptAnchorsJson: JSON.stringify({
                    startSeqInclusive: 1,
                    endSeqInclusive: 10,
                    userMessageSeqs: [1],
                }),
            });
            currentTx.sessionMessage.findFirst.mockResolvedValue({
                seq: 10,
                messageRole: "agent",
                sidechainId: null,
            });
            currentTx.sessionTurn.update.mockResolvedValue({
                ...completedTurnRow,
                transcriptAnchorsJson: JSON.stringify({
                    startSeqInclusive: 1,
                    endSeqInclusive: 10,
                    userMessageSeqs: [1],
                    finalAssistantMessageSeq: 10,
                }),
            });
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const accepted = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-valid-final-anchor",
                    turnId: "turn-1",
                    action: "complete",
                    transcriptAnchors: { finalAssistantMessageSeq: 10 },
                    observedAt: 201,
                },
            });

            expect(currentTx.sessionMessage.findFirst).toHaveBeenCalledWith({
                where: { sessionId: "s1", seq: 10 },
                select: { seq: true, messageRole: true, sidechainId: true },
            });
            expect(accepted).toMatchObject({ ok: true, didApply: true });
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

        it("persists a non-positive decision for an exact end-session target that is missing", async () => {
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
                    turnId: "turn-missing",
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
                    turnId: "turn-missing",
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
                    turnId: "turn-missing",
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
                agentTurnId: null,
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

        it.each(["completed", "failed", "cancelled"] as const)(
            "acknowledges exact daemon end after runtime terminalization of a %s turn without rewriting it",
            async (status) => {
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
                        latestTurnStatus: status,
                        latestTurnStatusObservedAt: BigInt(200),
                        lastRuntimeIssue: null,
                        active: true,
                        archivedAt: null,
                        shares: [],
                    })
                    .mockResolvedValueOnce({
                        latestTurnId: "turn-1",
                        latestTurnStatus: status,
                        latestTurnStatusObservedAt: BigInt(200),
                        lastRuntimeIssue: null,
                        active: true,
                        archivedAt: null,
                    });
                currentTx.sessionShare.findUnique.mockResolvedValue(null);
                currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
                currentTx.sessionTurn.findUnique.mockResolvedValue({
                    ...completedTurnRow,
                    status,
                });

                const res = await applySessionTurnMutation({
                    actorUserId: "u1",
                    mutation: {
                        v: 1,
                        sessionId: "s1",
                        mutationId: `daemon-end-${status}`,
                        action: "end_session",
                        turnId: "turn-1",
                        observedAt: 400,
                    },
                });

                expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
                expect(currentTx.session.update).not.toHaveBeenCalled();
                expect(currentTx.sessionTurnMutationReceipt.update).toHaveBeenCalledWith({
                    where: {
                        sessionId_mutationId: {
                            sessionId: "s1",
                            mutationId: `daemon-end-${status}`,
                        },
                    },
                    data: expect.objectContaining({
                        turnId: "turn-1",
                        action: "end_session",
                        decision: "duplicate-terminal",
                        observedAt: BigInt(400),
                    }),
                });
                expect(res).toMatchObject({
                    ok: true,
                    didApply: false,
                    reason: "terminal-turn",
                    receipt: {
                        turnId: "turn-1",
                        action: "end_session",
                        decision: "duplicate-terminal",
                    },
                    latestTurnId: "turn-1",
                    latestTurnStatus: status,
                    latestTurnStatusObservedAt: 200,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                });
            },
        );

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
                    turnId: "turn-2",
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
                    turnId: "turn-2",
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
                    ...hostedTranscriptPublication(),
                })
                // `markSessionParticipantsChanged` loads the publication again through
                // `loadSessionTranscriptPublication`; it is a second read, not the badge row.
                .mockResolvedValueOnce(hostedTranscriptPublication());
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
                    ...hostedTranscriptPublication(),
                })
                // `markSessionParticipantsChanged` loads the publication again through
                // `loadSessionTranscriptPublication`; it is a second read, not the badge row.
                .mockResolvedValueOnce(hostedTranscriptPublication());
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
                    ...hostedTranscriptPublication(),
                })
                // `markSessionParticipantsChanged` loads the publication again through
                // `loadSessionTranscriptPublication`; it is a second read, not the badge row.
                .mockResolvedValueOnce(hostedTranscriptPublication());
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
                    ...hostedTranscriptPublication(),
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
        it("does not scan transcript messages when the actor is unauthorized", async () => {
            currentTx.session.findUnique.mockResolvedValueOnce({ accountId: "owner" });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);

            const res = await applySessionReadCursorOperation({
                actorUserId: "intruder",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(dbMocks.db.sessionMessage.findMany).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.findMany).not.toHaveBeenCalled();
        });

        it("scans the published transcript outside transactions, then reauthorizes before lowering", async () => {
            const lifecycle: string[] = [];
            const initialAuthorizationTx = {
                session: {
                    findUnique: vi.fn()
                        .mockImplementationOnce(async () => {
                            lifecycle.push("initial-authorization");
                            return { accountId: "u1" };
                        })
                        .mockResolvedValueOnce({
                            seq: 11,
                            ...hostedTranscriptPublication(),
                        }),
                },
                sessionShare: { findUnique: vi.fn() },
                sessionMessage: {
                    findMany: vi.fn(() => {
                        throw new Error("transcript scan must not use the authorization transaction");
                    }),
                },
            };
            const finalTx = {
                session: {
                    findUnique: vi.fn()
                        .mockImplementationOnce(async () => {
                            lifecycle.push("final-authorization");
                            return { accountId: "u1" };
                        })
                        .mockImplementationOnce(async () => {
                            lifecycle.push("fresh-session");
                            return {
                                seq: 11,
                                ...hostedTranscriptPublication(),
                                lastViewedSessionSeq: 11,
                                latestReadyEventSeq: null,
                                latestTurnStatus: "in_progress",
                                pendingCount: 0,
                                pendingBlockedCount: 0,
                                pendingPermissionRequestCount: 0,
                                pendingUserActionRequestCount: 0,
                                active: true,
                                archivedAt: null,
                            };
                        })
                        .mockResolvedValueOnce(hostedTranscriptPublication()),
                    updateMany: vi.fn(async () => {
                        lifecycle.push("lower-cursor");
                        return { count: 1 };
                    }),
                },
                sessionShare: { findUnique: vi.fn() },
            };
            transactionQueue.push(
                initialAuthorizationTx as unknown as SessionWriteTxMock,
                finalTx as unknown as SessionWriteTxMock,
            );
            dbMocks.db.sessionMessage.findMany.mockImplementation(async (args) => {
                if (args.select?.transcriptObservationProvenance) {
                    lifecycle.push("external-scan");
                    return [
                        {
                            id: "m11",
                            seq: 11,
                            transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                        },
                        {
                            id: "m10",
                            seq: 10,
                            transcriptObservationProvenance: { kind: "non_dependent", source: "background" },
                        },
                        {
                            id: "m9",
                            seq: 9,
                            transcriptObservationProvenance: { kind: "non_dependent", source: "external" },
                        },
                        {
                            id: "m8",
                            seq: 8,
                            transcriptObservationProvenance: { kind: "non_dependent", source: "sidechain" },
                        },
                        {
                            id: "m7",
                            seq: 7,
                            transcriptObservationProvenance: { kind: "non_dependent", source: "guessed" },
                        },
                    ];
                }
                const quietEvent = {
                    t: "plain" as const,
                    v: {
                        role: "agent" as const,
                        content: {
                            type: "event" as const,
                            id: "quota-wait-event",
                            data: {
                                type: "agent-quota-wait" as const,
                                serviceId: "openai-codex",
                                groupId: "main",
                                resetAtMs: 1_900_000,
                                reason: "connected_service_group_quota_exhausted" as const,
                            },
                        },
                    },
                };
                return [
                    { id: "m10", content: quietEvent },
                    { id: "m9", content: quietEvent },
                    { id: "m8", content: quietEvent },
                    { id: "m7", content: { malformed: true } },
                ];
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(lifecycle).toEqual([
                "initial-authorization",
                "external-scan",
                "final-authorization",
                "fresh-session",
                "lower-cursor",
            ]);
            expect(initialAuthorizationTx.sessionMessage.findMany).not.toHaveBeenCalled();
            expect(dbMocks.db.sessionMessage.findMany).toHaveBeenNthCalledWith(2, {
                where: {
                    sessionId: "s1",
                    sidechainId: null,
                    id: { in: ["m10", "m9", "m8", "m7"] },
                },
                // The unread scan reads each row's localId so the divider attention
                // exemption is answered by the reserved-localId namespace, not the sidecar alone.
                select: { id: true, content: true, localId: true },
            });
            expect(finalTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    lastViewedSessionSeq: { gt: 6 },
                },
                data: { lastViewedSessionSeq: 6 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 6,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
                didChange: true,
                readState: "unread",
            });
        });

        it("does not lower from a stale scan boundary when fresh published state is already unread", async () => {
            const initialAuthorizationTx = {
                session: {
                    findUnique: vi.fn()
                        .mockResolvedValueOnce({ accountId: "u1" })
                        .mockResolvedValueOnce({ seq: 7, ...hostedTranscriptPublication() }),
                },
                sessionShare: { findUnique: vi.fn() },
            };
            const finalTx = {
                session: {
                    findUnique: vi.fn()
                        .mockResolvedValueOnce({ accountId: "u1" })
                        .mockResolvedValueOnce({
                            seq: 9,
                            ...hostedTranscriptPublication(),
                            lastViewedSessionSeq: 7,
                            latestReadyEventSeq: null,
                            latestTurnStatus: "in_progress",
                            pendingCount: 0,
                            pendingBlockedCount: 0,
                            pendingPermissionRequestCount: 0,
                            pendingUserActionRequestCount: 0,
                            active: true,
                            archivedAt: null,
                        }),
                    updateMany: vi.fn(),
                },
                sessionShare: { findUnique: vi.fn() },
            };
            transactionQueue.push(
                initialAuthorizationTx as unknown as SessionWriteTxMock,
                finalTx as unknown as SessionWriteTxMock,
            );
            dbMocks.db.sessionMessage.findMany
                .mockResolvedValueOnce([{
                    id: "m7",
                    seq: 7,
                    transcriptObservationProvenance: null,
                }])
                .mockResolvedValueOnce([{
                    id: "m7",
                    content: { t: "encrypted", c: "ciphertext" },
                }]);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(finalTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 7,
                participantCursors: [],
                badgeAttentionChanged: false,
                didChange: false,
                readState: "unread",
            });
        });

        it("marks unread by lowering the cursor with a lowering-aware write", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ seq: 8, ...hostedTranscriptPublication() })
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    ...hostedTranscriptPublication(),
                    lastViewedSessionSeq: 8,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce(hostedTranscriptPublication());
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findMany.mockResolvedValueOnce([]);
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

        it("uses the published content scan when raw seq only has maintenance events", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ seq: 742, ...hostedTranscriptPublication() })
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 742,
                    ...hostedTranscriptPublication(),
                    latestReadyEventSeq: 110,
                    lastViewedSessionSeq: 742,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "completed",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce(hostedTranscriptPublication());
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findMany
                .mockResolvedValueOnce([{
                    id: "m739",
                    seq: 739,
                    transcriptObservationProvenance: null,
                }])
                .mockResolvedValueOnce([{
                    id: "m739",
                    content: { t: "encrypted", c: "ciphertext" },
                }]);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(dbMocks.db.sessionMessage.findMany).toHaveBeenNthCalledWith(1, {
                where: {
                    sessionId: "s1",
                    sidechainId: null,
                },
                orderBy: { seq: "desc" },
                take: 100,
                select: {
                    id: true,
                    seq: true,
                    transcriptObservationProvenance: true,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    lastViewedSessionSeq: { gt: 738 },
                },
                data: { lastViewedSessionSeq: 738 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 738,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
                didChange: true,
                readState: "unread",
            });
        });

        it("excludes unpublished imported rows when deriving the manual-unread attention cursor", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 12,
                    currentStorageState: "server_partial",
                    acceptedThroughServerSeq: 8,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                })
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 12,
                    currentStorageState: "server_partial",
                    acceptedThroughServerSeq: 8,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                    latestReadyEventSeq: null,
                    lastViewedSessionSeq: 12,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "completed",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    currentStorageState: "server_partial",
                    acceptedThroughServerSeq: 8,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findMany
                .mockResolvedValueOnce([{
                    id: "published-agent-message",
                    seq: 8,
                    transcriptObservationProvenance: null,
                }])
                .mockResolvedValueOnce([{
                    id: "published-agent-message",
                    content: { t: "encrypted", c: "ciphertext" },
                }]);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(dbMocks.db.sessionMessage.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
                where: {
                    sessionId: "s1",
                    sidechainId: null,
                    seq: { lte: 8 },
                },
            }));
            expect(res).toEqual(expect.objectContaining({
                ok: true,
                lastViewedSessionSeq: 7,
                readState: "unread",
            }));
        });

        it("preserves null when marking unread is already represented by a missing cursor", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ seq: 8, ...hostedTranscriptPublication() })
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    ...hostedTranscriptPublication(),
                    lastViewedSessionSeq: null,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findMany.mockResolvedValueOnce([]);

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
                .mockResolvedValueOnce({ seq: 8, ...hostedTranscriptPublication() })
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    ...hostedTranscriptPublication(),
                    lastViewedSessionSeq: 8,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: new Date(123),
                })
                .mockResolvedValueOnce(hostedTranscriptPublication());
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findMany.mockResolvedValueOnce([]);
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
                    ...hostedTranscriptPublication(),
                })
                // `markSessionParticipantsChanged` loads the publication again through
                // `loadSessionTranscriptPublication`; it is a second read, not the badge row.
                .mockResolvedValueOnce(hostedTranscriptPublication());
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
        it("rejects layout-zero atomic patches from a non-owner editor", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "legacy-whole-bag",
                    agentStateVersion: 9,
                    agentState: "legacy-agent-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce({ accessLevel: "edit" });
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            markAccountChanged.mockResolvedValueOnce(10).mockResolvedValueOnce(11);

            const res = await patchSession({
                actorUserId: "u2",
                sessionId: "s1",
                metadata: { ciphertext: "shared-editor-write", expectedVersion: 5 },
                agentState: { ciphertext: null, expectedVersion: 9 },
            });

            expect(res).toEqual({
                ok: false,
                error: "forbidden",
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("atomically records a conditioned layout-zero model intent only while inactive", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [],
                })
                .mockResolvedValueOnce({
                    active: false,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "legacy-whole-bag",
                    encryptionMode: "e2ee",
                    agentStateVersion: 9,
                    agentState: "legacy-agent-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            markAccountChanged.mockResolvedValueOnce(10);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: {
                    ciphertext: "inactive-model-intent",
                    expectedVersion: 5,
                },
                sessionExpectation: {
                    kind: "inactive_model_intent",
                },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    active: false,
                    metadataVersion: 5,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                },
                data: {
                    metadata: "inactive-model-intent",
                    metadataVersion: 6,
                },
            });
            expect(res).toEqual({
                ok: true,
                participantCursors: expect.any(Array),
                metadata: {
                    version: 6,
                    value: "inactive-model-intent",
                },
            });
        });

        it("rejects a conditioned layout-zero model intent when the initial row is active", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [],
                })
                .mockResolvedValueOnce({
                    active: true,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "legacy-whole-bag",
                    encryptionMode: "e2ee",
                    agentStateVersion: 9,
                    agentState: "legacy-agent-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: {
                    ciphertext: "inactive-model-intent",
                    expectedVersion: 5,
                },
                sessionExpectation: {
                    kind: "inactive_model_intent",
                },
            });

            expect(res).toEqual({
                ok: false,
                error: "session_active",
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects a conditioned layout-zero model intent when a claim wins its CAS race", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [],
                })
                .mockResolvedValueOnce({
                    active: false,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "legacy-whole-bag",
                    encryptionMode: "e2ee",
                    agentStateVersion: 9,
                    agentState: "legacy-agent-state",
                })
                .mockResolvedValueOnce({
                    active: true,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "legacy-whole-bag",
                    agentStateVersion: 9,
                    agentState: "legacy-agent-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 0 });

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: {
                    ciphertext: "inactive-model-intent",
                    expectedVersion: 5,
                },
                sessionExpectation: {
                    kind: "inactive_model_intent",
                },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    active: false,
                    metadataVersion: 5,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                },
                data: {
                    metadata: "inactive-model-intent",
                    metadataVersion: 6,
                },
            });
            expect(res).toEqual({
                ok: false,
                error: "session_active",
            });
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("keeps an ordinary layout-zero metadata CAS unfenced by active state", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    shares: [],
                })
                .mockResolvedValueOnce({
                    active: true,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 5,
                    metadata: "legacy-whole-bag",
                    encryptionMode: "e2ee",
                    agentStateVersion: 9,
                    agentState: "legacy-agent-state",
                })
                .mockResolvedValueOnce(hostedTranscriptPublication());
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValueOnce(["u1"]);
            markAccountChanged.mockResolvedValueOnce(10);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: {
                    ciphertext: "ordinary-active-write",
                    expectedVersion: 5,
                },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    metadataVersion: 5,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                },
                data: {
                    metadata: "ordinary-active-write",
                    metadataVersion: 6,
                },
            });
            expect(res).toEqual({
                ok: true,
                participantCursors: [{ accountId: "u1", cursor: 10 }],
                metadata: {
                    version: 6,
                    value: "ordinary-active-write",
                },
            });
        });

        it("still rejects a layout-zero atomic patch from a view-only participant", async () => {
            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                encryptionMode: "e2ee",
                shares: [{ sharedWithUserId: "u2" }],
            });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce({ accessLevel: "view" });

            const res = await patchSession({
                actorUserId: "u2",
                sessionId: "s1",
                metadata: { ciphertext: "unauthorized-write", expectedVersion: 5 },
            });

            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("fences legacy writers after the privacy layout activates", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-safe",
                    agentStateVersion: 9,
                    agentState: "owner-full-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: { ciphertext: "legacy-whole-bag", expectedVersion: 5 },
                agentState: { ciphertext: "owner-full-state", expectedVersion: 9 },
            });

            expect(res).toEqual({
                ok: false,
                error: "metadata_privacy_upgrade_required",
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("fences before the legacy atomic patch version-mismatch path", async () => {
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

            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("fences the owner legacy atomic patch writer", async () => {
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

            expect(res).toEqual({ ok: false, error: "metadata_privacy_upgrade_required" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("does not return legacy tuple values when a future layout wins the atomic CAS race", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 1,
                    metadata: "legacy-metadata",
                    agentStateVersion: 2,
                    agentState: "legacy-state",
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 2,
                    ownerMetadata: null,
                    metadataVersion: 2,
                    metadata: "future-metadata",
                    agentStateVersion: 3,
                    agentState: "future-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: { ciphertext: "stale-metadata", expectedVersion: 1 },
                agentState: { ciphertext: "stale-state", expectedVersion: 2 },
            });

            expect(res).toEqual({
                ok: false,
                error: "metadata_privacy_upgrade_required",
            });
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("keeps semantic metadata and exact Agent-state no-ops version-stable", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 1,
                    metadata: "{\"a\":1,\"b\":2}",
                    encryptionMode: "plain",
                    agentStateVersion: 2,
                    agentState: "same-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: {
                    ciphertext: "{\"b\":2,\"a\":1}",
                    expectedVersion: 1,
                },
                agentState: {
                    ciphertext: "same-state",
                    expectedVersion: 2,
                },
            });

            expect(res).toEqual({
                ok: true,
                participantCursors: [],
                metadata: { version: 1, value: "{\"a\":1,\"b\":2}" },
                agentState: { version: 2, value: "same-state" },
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("increments only the changed field while fencing every supplied version and the layout", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    metadataVersion: 1,
                    metadata: "{\"a\":1}",
                    encryptionMode: "plain",
                    agentStateVersion: 2,
                    agentState: "before",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: {
                    ciphertext: "{ \"a\": 1 }",
                    expectedVersion: 1,
                },
                agentState: {
                    ciphertext: "after",
                    expectedVersion: 2,
                },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    metadataVersion: 1,
                    agentStateVersion: 2,
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                },
                data: {
                    agentState: "after",
                    agentStateVersion: 3,
                },
            });
            expect(res).toEqual({
                ok: true,
                participantCursors: expect.any(Array),
                metadata: { version: 1, value: "{\"a\":1}" },
                agentState: { version: 3, value: "after" },
            });
        });
    });

    describe("updateSessionMetadataEnvelopeTuple", () => {
        const previousOwnerMetadataCiphertext =
            "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==";
        const caseOnlyDistinctPreviousOwnerMetadataCiphertext =
            "oRoBAGMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==";
        const ownerMetadataCiphertext =
            "oRohIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzh6m869PVe0miAb8CnDsASVAnt9+tG1Zg==";
        const previousOwnerMetadataEnvelope = { t: "encrypted", c: previousOwnerMetadataCiphertext } as const;
        const caseOnlyDistinctPreviousOwnerMetadataEnvelope = { t: "encrypted", c: caseOnlyDistinctPreviousOwnerMetadataCiphertext } as const;
        const ownerMetadataEnvelope = { t: "encrypted", c: ownerMetadataCiphertext } as const;
        const storedPreviousOwnerMetadata = JSON.stringify(previousOwnerMetadataEnvelope);
        const storedCaseOnlyDistinctPreviousOwnerMetadata = JSON.stringify(caseOnlyDistinctPreviousOwnerMetadataEnvelope);
        const storedOwnerMetadata = JSON.stringify(ownerMetadataEnvelope);

        beforeEach(() => {
            storagePolicyEnv.set("HAPPIER_DB_PROVIDER", "postgres");
            const accountContentBinding =
                createAccountContentBinding();
            currentTx.account.findUnique.mockResolvedValue({
                encryptionMode: "e2ee",
                publicKey: accountContentBinding.publicKey,
                contentPublicKey:
                    accountContentBinding.contentPublicKey,
                contentPublicKeySig:
                    accountContentBinding.contentPublicKeySig,
            });
            currentTx.$queryRawUnsafe = vi.fn(
                async (_query: string, accountId: string) => [{ id: accountId }],
            );
            currentTx.$executeRawUnsafe = vi.fn(async () => 1);
        });

        it.each([
            {
                accountMode: "plain" as const,
                account: {
                    encryptionMode: "plain",
                    publicKey: null,
                    contentPublicKey: null,
                    contentPublicKeySig: null,
                },
                ownerEnvelope: ownerMetadataEnvelope,
            },
            {
                accountMode: "e2ee" as const,
                account: null,
                ownerEnvelope: {
                    t: "plain" as const,
                    v: { v: 1 as const },
                },
            },
        ])("rejects a $accountMode Account owner-envelope mismatch before fence or Session effects", async ({
            account,
            ownerEnvelope,
        }) => {
            if (account) {
                currentTx.account.findUnique.mockResolvedValue(account);
            }

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: ownerEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-new",
                    expectedVersion: 4,
                },
                ownerMetadata: ownerEnvelope,
                agentState: {
                    ciphertext: "agent-new",
                    expectedVersion: 8,
                },
            });

            expect(res).toEqual({
                ok: false,
                error: "invalid-params",
            });
            expect(currentTx.$queryRawUnsafe).not.toHaveBeenCalled();
            expect(currentTx.$executeRawUnsafe).not.toHaveBeenCalled();
            expect(currentTx.session.findUnique).not.toHaveBeenCalled();
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("acquires the actor Account fence before owner Session access", async () => {
            const callLog: string[] = [];
            currentTx.$queryRawUnsafe = vi.fn(
                async (_query: string, accountId: string) => {
                    callLog.push(`fence:${accountId}`);
                    return [{ id: accountId }];
                },
            );
            currentTx.session.findUnique
                .mockImplementationOnce(async () => {
                    callLog.push("session:access");
                    return { accountId: "u1", shares: [] };
                })
                .mockImplementationOnce(async () => {
                    callLog.push("session:tuple");
                    return {
                        metadataLayoutVersion: 1,
                        metadataVersion: 4,
                        metadata: "shared-old",
                        ownerMetadata: storedPreviousOwnerMetadata,
                        agentStateVersion: 8,
                        agentState: "agent-old",
                    };
                });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValue(10);

            await updateSessionMetadataEnvelopeTuple({
                mode: "owner",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-new",
                    expectedVersion: 4,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: "agent-new",
                    expectedVersion: 8,
                },
            });

            expect(callLog.slice(0, 3)).toEqual([
                "fence:u1",
                "session:access",
                "session:tuple",
            ]);
        });

        it("atomically records a conditioned owner tuple only while inactive", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    active: false,
                    metadataLayoutVersion: 1,
                    metadataVersion: 4,
                    metadata: "shared-old",
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 8,
                    agentState: "agent-old",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValueOnce(["u1"]);
            markAccountChanged.mockResolvedValueOnce(10);

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner_inactive_model_intent",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                sessionExpectation: {
                    kind: "inactive_model_intent",
                },
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-new",
                    expectedVersion: 4,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: "agent-new",
                    expectedVersion: 8,
                },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    active: false,
                    metadataLayoutVersion: 1,
                    metadataVersion: 4,
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 8,
                },
                data: {
                    metadata: "shared-new",
                    metadataVersion: 5,
                    ownerMetadata: storedOwnerMetadata,
                    metadataLayoutVersion: 1,
                    agentState: "agent-new",
                    agentStateVersion: 9,
                },
            });
            expect(res).toEqual({
                ok: true,
                participantCursors: [{ accountId: "u1", cursor: 10 }],
                sessionOwnerId: "u1",
                ownerAccountMode: "e2ee",
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 5, value: "shared-new" },
                agentStateVersion: 9,
                ownerMetadata: { value: storedOwnerMetadata },
                agentState: { version: 9, value: "agent-new" },
            });
        });

        it("rejects a conditioned owner tuple when the initial row is active", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    active: true,
                    metadataLayoutVersion: 1,
                    metadataVersion: 4,
                    metadata: "shared-old",
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 8,
                    agentState: "agent-old",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner_inactive_model_intent",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                sessionExpectation: {
                    kind: "inactive_model_intent",
                },
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-new",
                    expectedVersion: 4,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: "agent-new",
                    expectedVersion: 8,
                },
            });

            expect(res).toEqual({
                ok: false,
                error: "session_active",
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("preserves an exact conditioned lost-ack result after the Session activates", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    active: true,
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-new",
                    ownerMetadata: storedOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "agent-new",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner_inactive_model_intent",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                sessionExpectation: {
                    kind: "inactive_model_intent",
                },
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-new",
                    expectedVersion: 4,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: "agent-new",
                    expectedVersion: 8,
                },
            });

            expect(res).toEqual({
                ok: true,
                participantCursors: [],
                sessionOwnerId: "u1",
                ownerAccountMode: "e2ee",
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 5, value: "shared-new" },
                agentStateVersion: 9,
                ownerMetadata: { value: storedOwnerMetadata },
                agentState: { version: 9, value: "agent-new" },
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects a conditioned owner tuple when a claim wins its CAS race", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    active: false,
                    metadataLayoutVersion: 1,
                    metadataVersion: 4,
                    metadata: "shared-old",
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 8,
                    agentState: "agent-old",
                })
                .mockResolvedValueOnce({
                    active: true,
                    metadataLayoutVersion: 1,
                    metadataVersion: 4,
                    metadata: "shared-old",
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 8,
                    agentState: "agent-old",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 0 });

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner_inactive_model_intent",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                sessionExpectation: {
                    kind: "inactive_model_intent",
                },
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-new",
                    expectedVersion: 4,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: "agent-new",
                    expectedVersion: 8,
                },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    active: false,
                    metadataLayoutVersion: 1,
                    metadataVersion: 4,
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 8,
                },
                data: {
                    metadata: "shared-new",
                    metadataVersion: 5,
                    ownerMetadata: storedOwnerMetadata,
                    metadataLayoutVersion: 1,
                    agentState: "agent-new",
                    agentStateVersion: 9,
                },
            });
            expect(res).toEqual({
                ok: false,
                error: "session_active",
            });
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("preserves an exact conditioned lost-ack result found after a zero-count CAS reread", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    active: false,
                    metadataLayoutVersion: 1,
                    metadataVersion: 4,
                    metadata: "shared-old",
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 8,
                    agentState: "agent-old",
                })
                .mockResolvedValueOnce({
                    active: true,
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-new",
                    ownerMetadata: storedOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "agent-new",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 0 });

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner_inactive_model_intent",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                sessionExpectation: {
                    kind: "inactive_model_intent",
                },
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-new",
                    expectedVersion: 4,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: "agent-new",
                    expectedVersion: 8,
                },
            });

            expect(res).toEqual({
                ok: true,
                participantCursors: [],
                sessionOwnerId: "u1",
                ownerAccountMode: "e2ee",
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 5, value: "shared-new" },
                agentStateVersion: 9,
                ownerMetadata: { value: storedOwnerMetadata },
                agentState: { version: 9, value: "agent-new" },
            });
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("keeps an ordinary owner tuple CAS unfenced by active state", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    active: true,
                    metadataLayoutVersion: 1,
                    metadataVersion: 4,
                    metadata: "shared-old",
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 8,
                    agentState: "agent-old",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValueOnce(["u1"]);
            markAccountChanged.mockResolvedValueOnce(10);

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-new",
                    expectedVersion: 4,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: "agent-new",
                    expectedVersion: 8,
                },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    metadataLayoutVersion: 1,
                    metadataVersion: 4,
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 8,
                },
                data: {
                    metadata: "shared-new",
                    metadataVersion: 5,
                    ownerMetadata: storedOwnerMetadata,
                    metadataLayoutVersion: 1,
                    agentState: "agent-new",
                    agentStateVersion: 9,
                },
            });
            expect(res).toEqual({
                ok: true,
                participantCursors: [{ accountId: "u1", cursor: 10 }],
                sessionOwnerId: "u1",
                ownerAccountMode: "e2ee",
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 5, value: "shared-new" },
                agentStateVersion: 9,
                ownerMetadata: { value: storedOwnerMetadata },
                agentState: { version: 9, value: "agent-new" },
            });
        });

        it("does not acquire the Account fence for a shared-editor mutation", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-old",
                    ownerMetadata: storedOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "owner-full-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce({
                accessLevel: "edit",
            });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(10).mockResolvedValueOnce(11);

            await updateSessionMetadataEnvelopeTuple({
                mode: "shared_editor",
                actorUserId: "u2",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                sharedMetadata: {
                    ciphertext: "shared-new",
                    expectedVersion: 5,
                },
            });

            expect(currentTx.$queryRawUnsafe).not.toHaveBeenCalled();
            expect(currentTx.$executeRawUnsafe).not.toHaveBeenCalled();
        });

        it("requires authenticated ownership even when a share grants edit access", async () => {
            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                shares: [{ sharedWithUserId: "u2" }],
            });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce({ accessLevel: "edit" });

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner",
                actorUserId: "u2",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: { ciphertext: "shared-safe", expectedVersion: 4 },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: { ciphertext: "owner-full-state", expectedVersion: 8 },
            });

            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("refuses owner tuple writes while activation remains closed on a layout-zero row", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    metadataVersion: 4,
                    metadata: "legacy-whole-bag",
                    ownerMetadata: null,
                    agentStateVersion: 8,
                    agentState: "owner-full-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: { ciphertext: "shared-safe", expectedVersion: 4 },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: { ciphertext: "owner-full-state", expectedVersion: 8 },
            });

            expect(res).toEqual({
                ok: false,
                error: "metadata_privacy_upgrade_required",
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("treats a lost acknowledgement retry of the exact resulting tuple as idempotent", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-safe",
                    ownerMetadata: storedOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "owner-full-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: { ciphertext: "shared-safe", expectedVersion: 4 },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: { ciphertext: "owner-full-state", expectedVersion: 8 },
            });

            expect(res).toEqual({
                ok: true,
                participantCursors: [],
                sessionOwnerId: "u1",
                ownerAccountMode: "e2ee",
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 5, value: "shared-safe" },
                agentStateVersion: 9,
                ownerMetadata: { value: storedOwnerMetadata },
                agentState: { version: 9, value: "owner-full-state" },
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects a stale pre-reseal owner ciphertext even when shared and Agent versions are current", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-current",
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "agent-current",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 1 });

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: ownerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-stale-writer-replacement",
                    expectedVersion: 5,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: "agent-stale-writer-replacement",
                    expectedVersion: 9,
                },
            });

            expect(res).toEqual({
                ok: false,
                error: "version-mismatch",
                current: {
                    metadataLayoutVersion: 1,
                    sharedMetadata: {
                        version: 5,
                        value: "shared-current",
                    },
                    ownerMetadata: {
                        value: storedPreviousOwnerMetadata,
                    },
                    agentState: {
                        version: 9,
                        value: "agent-current",
                    },
                },
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("keeps the case-exact expected owner ciphertext in the atomic Session-row CAS", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-current",
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "agent-current",
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-current",
                    ownerMetadata:
                        storedCaseOnlyDistinctPreviousOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "agent-current",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 0 });

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: previousOwnerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "shared-replacement",
                    expectedVersion: 5,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: "agent-replacement",
                    expectedVersion: 9,
                },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    ownerMetadata: storedPreviousOwnerMetadata,
                    agentStateVersion: 9,
                },
                data: {
                    metadata: "shared-replacement",
                    metadataVersion: 6,
                    ownerMetadata: storedOwnerMetadata,
                    metadataLayoutVersion: 1,
                    agentState: "agent-replacement",
                    agentStateVersion: 10,
                },
            });
            expect(res).toEqual({
                ok: false,
                error: "version-mismatch",
                current: {
                    metadataLayoutVersion: 1,
                    sharedMetadata: {
                        version: 5,
                        value: "shared-current",
                    },
                    ownerMetadata: {
                        value:
                            storedCaseOnlyDistinctPreviousOwnerMetadata,
                    },
                    agentState: {
                        version: 9,
                        value: "agent-current",
                    },
                },
            });
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("lets an editor update only the shared envelope on an already split row", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-old",
                    ownerMetadata: storedOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "owner-full-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce({ accessLevel: "edit" });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(10).mockResolvedValueOnce(11);

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "shared_editor",
                actorUserId: "u2",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: "shared-new", expectedVersion: 5 },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    OR: [
                        { accountId: "u2" },
                        {
                            shares: {
                                some: {
                                    sharedWithUserId: "u2",
                                    accessLevel: { in: ["edit", "admin"] },
                                },
                            },
                        },
                    ],
                },
                data: {
                    metadata: "shared-new",
                    metadataVersion: 6,
                },
            });
            expect(res).toEqual({
                ok: true,
                participantCursors: [
                    { accountId: "u1", cursor: 10 },
                    { accountId: "u2", cursor: 11 },
                ],
                sessionOwnerId: "u1",
                ownerAccountMode: "e2ee",
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 6, value: "shared-new" },
                agentStateVersion: 9,
                ownerMetadata: { value: storedOwnerMetadata },
                agentState: {
                    version: 9,
                    value: "owner-full-state",
                },
            });
        });

        it("fences a shared-editor write when edit access is revoked after the access read", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-old",
                    ownerMetadata: storedOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "owner-full-state",
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    metadata: "shared-old",
                    ownerMetadata: storedOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "owner-full-state",
                })
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [{ sharedWithUserId: "u2" }],
                });
            currentTx.sessionShare.findUnique
                .mockResolvedValueOnce({ accessLevel: "edit" })
                .mockResolvedValueOnce({ accessLevel: "view" });
            currentTx.session.updateMany.mockResolvedValueOnce({ count: 0 });

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "shared_editor",
                actorUserId: "u2",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: "shared-new", expectedVersion: 5 },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    metadataLayoutVersion: 1,
                    metadataVersion: 5,
                    OR: [
                        { accountId: "u2" },
                        {
                            shares: {
                                some: {
                                    sharedWithUserId: "u2",
                                    accessLevel: { in: ["edit", "admin"] },
                                },
                            },
                        },
                    ],
                },
                data: {
                    metadata: "shared-new",
                    metadataVersion: 6,
                },
            });
            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects shared-editor writes until the owner has atomically split the row", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 0,
                    metadataVersion: 5,
                    metadata: "legacy-whole-bag",
                    ownerMetadata: null,
                    agentStateVersion: 9,
                    agentState: "owner-full-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValueOnce({ accessLevel: "edit" });

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "shared_editor",
                actorUserId: "u2",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: "shared-new", expectedVersion: 5 },
            });

            expect(res).toEqual({
                ok: false,
                error: "metadata_privacy_upgrade_required",
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("does not let a stale owner tuple overwrite a newer shared-editor envelope", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", shares: [] })
                .mockResolvedValueOnce({
                    metadataLayoutVersion: 1,
                    metadataVersion: 6,
                    metadata: "shared-editor-newer",
                    ownerMetadata: storedOwnerMetadata,
                    agentStateVersion: 9,
                    agentState: "owner-full-state",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await updateSessionMetadataEnvelopeTuple({
                mode: "owner",
                actorUserId: "u1",
                sessionId: "s1",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: ownerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: "stale-owner-shared-copy",
                    expectedVersion: 5,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: { ciphertext: "owner-full-state-next", expectedVersion: 9 },
            });

            expect(res).toEqual({
                ok: false,
                error: "version-mismatch",
                current: {
                    metadataLayoutVersion: 1,
                    sharedMetadata: {
                        version: 6,
                        value: "shared-editor-newer",
                    },
                    ownerMetadata: {
                        value: storedOwnerMetadata,
                    },
                    agentState: {
                        version: 9,
                        value: "owner-full-state",
                    },
                },
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });
    });
});
