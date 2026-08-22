import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import { mapPendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";
import {
    resolveSessionPendingEditAccess,
    resolveSessionPendingOwnerAccess,
    resolveSessionPendingViewAccess,
} from "@/app/session/pending/resolveSessionPendingAccess";
import type { PendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";
import { db } from "@/storage/db";
import { inTx, isTransactionAcquisitionUnavailableError, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1,
    isStoredContentKindAllowedForSessionByStoragePolicy,
    isPendingDeliveryArchivedUncertaintyReasonV1,
    isPendingDeliveryProviderEffectPossibleV1,
    isConditionalPendingSteerClaim,
    isPendingDeliveryStatusTransitionAllowedV1,
    isSessionAgentTransitionDividerLocalId,
    normalizePendingDeliveryBlockedReason,
    normalizePendingDeliveryStatusV1,
    normalizePendingRequestedActionV1,
    isPendingLocalId,
    readPendingLocalId,
    PendingMessageMutationFingerprintV1Schema,
    PendingRequestedActionV1Schema,
    SessionInputAdmissionReceiptV1Schema,
    SessionInputAdmissionRejectionCodeV1Schema,
    SessionInputRequestEqualityEvidenceV1Schema,
    supportsMachineOperationProtocolCapabilityV1,
    readSessionInputAuthorityV1,
    readSessionInputRequestV1,
    withSessionInputAuthorityV1,
    parseSessionMessageDeliveryResolutionV1,
    pendingDeliveryStatusV1ToPersistedFields,
    type PendingDeliveryBlockedReason,
    type PendingDeliveryStatusTransitionTargetV1,
    type PendingDeliveryStatusV1,
    type PendingRequestedActionV1,
    type SessionInputAdmissionReceiptV1,
    type SessionInputAdmissionRejectionCodeV1,
    type SessionInputAdmissionResultV1,
    type SessionInputSettlementValidationV1,
    type SessionStoredMessageContent,
    type SessionInputRequestEqualityEvidenceV1,
    type SessionMessageRole,
    type SessionStoredContentKind,
} from "@happier-dev/protocol";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { reserveNextPendingQueuePosition } from "@/app/session/pending/reserveNextPendingQueuePosition";
import { parseSessionMessageRole, resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { hasExactCurrentPublisherAuthorityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import {
    createSessionMessageFromPending,
    derivePlainRequestEqualityEvidence,
    type PendingTranscriptMessage,
} from "@/app/session/pending/pendingMessageTranscriptCommit";
import { compareSessionMessageContentAndRole } from "@/app/session/sessionTranscriptWrite";
import {
    resolveReadyProjectionEventType,
    updateSessionMessageActivityProjection,
    type SessionReadyProjectionUpdate,
} from "@/app/session/sessionWriteService";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { warn } from "@/utils/logging/log";

type ParticipantCursor = SessionParticipantCursor;
type PendingActivationTarget = Readonly<{
    accountId: string;
    requestId: string;
}>;

function pendingRequestedActionReplacementData(
    requestedAction: PendingRequestedActionV1,
    updatedAt: Date,
) {
    return {
        requestedAction,
        providerAction: null,
        deliveryState: null,
        deliveryBlockedReason: null,
        updatedAt,
    } as const;
}
type PendingServiceTx = Tx;

/**
 * Ordinary editor, delete, discard, restore, and reorder operations must not
 * race a delivery whose provider effect may already exist. The delivery-status
 * protocol owns that classification so newly represented uncertainty cannot
 * silently become editable here.
 */
function isOrdinaryPendingMutationFenced(fields: Readonly<{
    status: unknown;
    deliveryState?: unknown;
    deliveryBlockedReason?: unknown;
    discardedReason?: unknown;
}>): boolean {
    return isPendingDeliveryProviderEffectPossibleV1(normalizePendingDeliveryStatusV1(fields));
}

function deriveAccountInputAdmissionReceipt(params: Readonly<{
    actorAccountId: string;
    access: Extract<Awaited<ReturnType<typeof resolveSessionPendingEditAccess>>, { ok: true }>;
}>): Extract<SessionInputAdmissionReceiptV1, { issuer: "authenticatedAccount" }> {
    const receipt = {
        v: 1 as const,
        issuer: "authenticatedAccount" as const,
        actorAccountId: params.actorAccountId,
        sessionRelationship: params.access.isOwner
            ? "owner" as const
            : params.access.level === "admin"
                ? "sharedAdmin" as const
                : "sharedEditor" as const,
    };
    const parsed = SessionInputAdmissionReceiptV1Schema.parse(receipt);
    if (parsed.issuer !== "authenticatedAccount") {
        throw new Error("Account admission receipt parsed to the wrong issuer arm");
    }
    return parsed;
}

function isSameAdmissionIssuer(
    existing: SessionInputAdmissionReceiptV1,
    current: SessionInputAdmissionReceiptV1,
): boolean {
    if (existing.issuer !== current.issuer) return false;
    return existing.issuer === "authenticatedMachine"
        || current.issuer === "authenticatedAccount"
            && existing.actorAccountId === current.actorAccountId;
}

function isPendingDeliveryResolutionRaceError(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2002") || isPrismaErrorCode(error, "P2025");
}

async function rejoinPendingDeliveryResolutionRace<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!isPendingDeliveryResolutionRaceError(error)) {
            throw error;
        }
        return operation();
    }
}

export type { PendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";

export type ListPendingMessagesResult =
    | { ok: true; pending: PendingMessageRow[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export type ReadSessionPendingStateResult =
    | { ok: true; pendingCount: number; pendingBlockedCount: number; pendingVersion: number }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function readSessionPendingState(params: {
    actorUserId: string;
    sessionId: string;
}): Promise<ReadSessionPendingStateResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        if (!session) return { ok: false, error: "session-not-found" };
        return {
            ok: true,
            pendingCount: session.pendingCount ?? 0,
            pendingBlockedCount: session.pendingBlockedCount ?? 0,
            pendingVersion: session.pendingVersion ?? 0,
        };
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function listPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    includeDiscarded?: boolean;
}): Promise<ListPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const includeDiscarded = params.includeDiscarded === true;

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingViewAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    const select = {
        localId: true,
        messageRole: true,
        content: true,
        requestedAction: true,
        status: true,
        deliveryState: true,
        deliveryBlockedReason: true,
        position: true,
        createdAt: true,
        updatedAt: true,
        discardedAt: true,
        discardedReason: true,
        authorAccountId: true,
    } as const;

    try {
        if (!includeDiscarded) {
            const rows = await db.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select,
            });
            return { ok: true, pending: rows.map(mapPendingMessageRow) };
        }

        const [queued, discarded] = await Promise.all([
            db.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select,
            }),
            db.sessionPendingMessage.findMany({
                where: {
                    sessionId,
                    status: "discarded",
                    OR: [
                        { discardedReason: null },
                        { discardedReason: { notIn: [...PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1] } },
                    ],
                },
                orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
                select,
            }),
        ]);

        return { ok: true, pending: [...queued.map(mapPendingMessageRow), ...discarded.map(mapPendingMessageRow)] };
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type EnqueuePendingMessageResult =
    | {
        ok: true;
        terminal?: false;
        suppressed?: false;
        didWrite: boolean;
        pending: PendingMessageRow;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        badgeAttentionChanged: boolean;
        participantCursors: ParticipantCursor[];
        meaningfulActivityAt?: Date;
        activationTarget?: PendingActivationTarget;
      }
    | {
        ok: true;
        terminal: true;
        suppressed?: false;
        didWrite: false;
        message: PendingTranscriptMessage & { requestedAction: PendingRequestedActionV1 };
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        badgeAttentionChanged: false;
        participantCursors: [];
      }
    | {
        ok: true;
        terminal?: false;
        suppressed: true;
        didWrite: false;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        badgeAttentionChanged: false;
        participantCursors: [];
      }
    | {
        ok: false;
        error: "session-not-found" | "forbidden" | "invalid-params" | "internal";
        code?: EncryptionPolicyRejectionCode;
        admissionRejectionCode?: SessionInputAdmissionRejectionCodeV1;
      };

type EnqueuePendingMessageInput = {
    actorUserId: string;
    sessionId: string;
    localId: string;
    messageRole?: unknown;
    deliveryMode?: "external_handoff";
    admissionMode?: "continuation_if_no_queued_user_input";
    requestedAction: PendingRequestedActionV1;
    requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
);

type PendingMessageAdmissionContext =
    | Readonly<{
        kind: "account";
        inputAdmissionReceipt: Extract<SessionInputAdmissionReceiptV1, { issuer: "authenticatedAccount" }>;
      }>
    | Readonly<{
        kind: "machine";
        sourceMachineId: string;
        targetMachineId: string;
        inputAdmissionReceipt: Extract<SessionInputAdmissionReceiptV1, { issuer: "authenticatedMachine" }>;
      }>;

export async function enqueuePendingMessage(
    params: EnqueuePendingMessageInput,
): Promise<EnqueuePendingMessageResult> {
    // Equality evidence is host-derived E2EE correspondence carried only over
    // the authenticated machine admission route. An Account request cannot
    // author or replay that protected assertion.
    if (params.requestEqualityEvidenceV1 !== undefined) {
        return { ok: false, error: "invalid-params" };
    }
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };
    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };
    const inputAdmissionReceipt = deriveAccountInputAdmissionReceipt({
        actorAccountId: actorUserId,
        access,
    });
    return await enqueuePendingMessageWithAdmission(params, {
        kind: "account",
        inputAdmissionReceipt,
    });
}

async function enqueuePendingMessageWithAdmission(
    params: EnqueuePendingMessageInput,
    admission: PendingMessageAdmissionContext,
): Promise<EnqueuePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const deliveryMode = params.deliveryMode === undefined || params.deliveryMode === "external_handoff"
        ? params.deliveryMode
        : null;
    const admissionMode = params.admissionMode === undefined || params.admissionMode === "continuation_if_no_queued_user_input"
        ? params.admissionMode
        : null;
    const requestedActionResult = PendingRequestedActionV1Schema.safeParse(params.requestedAction);
    const requestEqualityEvidenceResult = params.requestEqualityEvidenceV1 === undefined
        ? undefined
        : SessionInputRequestEqualityEvidenceV1Schema.safeParse(params.requestEqualityEvidenceV1);
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const content =
        "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionPendingMessageContent) : null;

    if (
        !actorUserId
        || !sessionId
        || !localId
        || !content
        || deliveryMode === null
        || admissionMode === null
        || !requestedActionResult.success
        || requestEqualityEvidenceResult !== undefined && !requestEqualityEvidenceResult.success
    ) {
        return { ok: false, error: "invalid-params" };
    }
    const requestedAction = requestedActionResult.data;
    if (content.t === "encrypted" && (!content.c || typeof content.c !== "string")) return { ok: false, error: "invalid-params" };
    if (content.t === "plain" && !("v" in content)) return { ok: false, error: "invalid-params" };
    if (
        content.t === "plain" && requestEqualityEvidenceResult !== undefined
        || content.t === "encrypted"
            && requestEqualityEvidenceResult !== undefined
            && requestEqualityEvidenceResult.data.kind !== "e2eeTag"
    ) {
        return { ok: false, error: "invalid-params" };
    }
    const requestEqualityEvidenceV1 = requestEqualityEvidenceResult?.data;

    // A Pending row materializes into a transcript row under its own localId,
    // so every Pending ingress is a generic client-facing message ingress. The
    // reserved Agent-transition divider namespace is refused HERE, at the one
    // admission choke point every Pending adapter funnels through, rather than
    // at each adapter: an authenticated Machine on the same Account reaches
    // this owner without passing any route, and a row planted at the
    // deterministic divider id would permanently conflict every future cutover
    // for that Session. `invalid-params` is the already-understood typed
    // failure — the HTTP adapter answers 400 `invalid-params` and the Machine
    // adapter answers `rejected`/`session_input_invalid`.
    if (isSessionAgentTransitionDividerLocalId(localId)) {
        return { ok: false, error: "invalid-params" };
    }

    const inputAdmissionReceipt = admission.inputAdmissionReceipt;

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: {
                    accountId: true,
                    active: true,
                    archivedAt: true,
                    encryptionMode: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                },
            });
            if (!session) return { ok: false, error: "session-not-found" } as const;
            if (session.archivedAt !== null) {
                return {
                    ok: false,
                    error: "invalid-params",
                    admissionRejectionCode: "session_input_archived",
                } as const;
            }
            if (admission.kind === "machine") {
                if (session.accountId !== actorUserId) {
                    return {
                        ok: false,
                        error: "session-not-found",
                        admissionRejectionCode: "session_input_unauthorized",
                    } as const;
                }
                const [sourceMachine, targetAccess] = await Promise.all([
                    tx.machine.findFirst({
                        where: { accountId: actorUserId, id: admission.sourceMachineId },
                        select: { revokedAt: true, replacedByMachineId: true },
                    }),
                    tx.accessKey.findUnique({
                        where: {
                            accountId_machineId_sessionId: {
                                accountId: actorUserId,
                                machineId: admission.targetMachineId,
                                sessionId,
                            },
                        },
                        select: {
                            session: { select: { accountId: true } },
                            machine: {
                                select: {
                                    revokedAt: true,
                                    replacedByMachineId: true,
                                    operationProtocolCapabilities: true,
                                    operationProtocolCapabilitiesRevision: true,
                                },
                            },
                        },
                    }),
                ]);
                if (
                    !sourceMachine
                    || sourceMachine.revokedAt !== null
                    || sourceMachine.replacedByMachineId !== null
                ) {
                    return {
                        ok: false,
                        error: "forbidden",
                        admissionRejectionCode: "session_input_unauthorized",
                    } as const;
                }
                if (
                    !targetAccess
                    || targetAccess.session.accountId !== actorUserId
                    || targetAccess.machine.revokedAt !== null
                    || targetAccess.machine.replacedByMachineId !== null
                ) {
                    return {
                        ok: false,
                        error: "session-not-found",
                        admissionRejectionCode: "session_input_target_unavailable",
                    } as const;
                }
                if (
                    typeof targetAccess.machine.operationProtocolCapabilitiesRevision !== "number"
                    || targetAccess.machine.operationProtocolCapabilitiesRevision < 1
                    || !supportsMachineOperationProtocolCapabilityV1(
                        targetAccess.machine.operationProtocolCapabilities,
                        "sessionInputAdmission",
                    )
                ) {
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: "session_input_target_update_required",
                    } as const;
                }
            }

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: params.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-message",
                },
            }).messageRole;
            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            const policy = readEncryptionFeatureEnv(process.env);
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return {
                    ok: false,
                    error: "invalid-params",
                    code: resolveEncryptionWriteRejectionCode({
                        storagePolicy: policy.storagePolicy,
                        sessionEncryptionMode,
                        writeKind,
                    }),
                } as const;
            }

            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    localId: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    position: true,
                    createdAt: true,
                    updatedAt: true,
                    discardedAt: true,
                    discardedReason: true,
                    authorAccountId: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                },
            });
            if (existing) {
                if (
                    deliveryMode === "external_handoff"
                    && (
                        existing.status !== "queued"
                        || existing.deliveryState !== "external_handoff"
                    )
                ) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                if (!isDeepStrictEqual(normalizePendingRequestedActionV1(existing.requestedAction), requestedAction)) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                const existingReceipt = existing.inputAdmissionReceipt == null
                    ? null
                    : SessionInputAdmissionReceiptV1Schema.safeParse(existing.inputAdmissionReceipt);
                if (
                    admission.kind === "account"
                        ? existing.authorAccountId !== actorUserId
                            || existingReceipt !== null
                                && (!existingReceipt.success || !isSameAdmissionIssuer(existingReceipt.data, inputAdmissionReceipt))
                        : existing.authorAccountId !== null
                            || existingReceipt === null
                            || !existingReceipt.success
                            || !isSameAdmissionIssuer(existingReceipt.data, inputAdmissionReceipt)
                ) {
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: "session_input_idempotency_conflict",
                    } as const;
                }
                const existingEqualityEvidence = existing.requestEqualityEvidenceV1 == null
                    ? null
                    : SessionInputRequestEqualityEvidenceV1Schema.safeParse(existing.requestEqualityEvidenceV1);
                if (existingEqualityEvidence !== null && !existingEqualityEvidence.success) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                const matchedOpaqueEquality = requestEqualityEvidenceV1?.kind === "e2eeTag"
                    && existingEqualityEvidence !== null
                    && isDeepStrictEqual(existingEqualityEvidence.data, requestEqualityEvidenceV1);
                if (
                    requestEqualityEvidenceV1 !== undefined && !matchedOpaqueEquality
                    || requestEqualityEvidenceV1 === undefined && existingEqualityEvidence !== null
                    || !matchedOpaqueEquality && !isDeepStrictEqual(existing.content, content)
                    || existing.messageRole !== null && existing.messageRole !== messageRole
                ) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                if (existing.status === "discarded") {
                    const rejection = SessionInputAdmissionRejectionCodeV1Schema.safeParse(existing.discardedReason);
                    if (!rejection.success) return { ok: false, error: "invalid-params" } as const;
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: rejection.data,
                    } as const;
                }
                let pending = existing;
                if (
                    existing.messageRole === null
                    && messageRole !== null
                    && (matchedOpaqueEquality || isDeepStrictEqual(existing.content, content))
                ) {
                    pending = await tx.sessionPendingMessage.update({
                        where: { sessionId_localId: { sessionId, localId } },
                        data: { messageRole },
                        select: {
                            localId: true,
                            messageRole: true,
                            content: true,
                            requestedAction: true,
                            status: true,
                            deliveryState: true,
                            deliveryBlockedReason: true,
                            position: true,
                            createdAt: true,
                            updatedAt: true,
                            discardedAt: true,
                            discardedReason: true,
                            authorAccountId: true,
                            inputAdmissionReceipt: true,
                            requestEqualityEvidenceV1: true,
                        },
                    });
                }
                return {
                    ok: true,
                    didWrite: false,
                    pending: mapPendingMessageRow(pending),
                    pendingCount: session.pendingCount ?? 0,
                    pendingBlockedCount: session.pendingBlockedCount ?? 0,
                    pendingVersion: session.pendingVersion ?? 0,
                    badgeAttentionChanged: false,
                    participantCursors: [],
                };
            }

            const terminalTranscript = await tx.sessionMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    content: true,
                    messageRole: true,
                    deliveryResolution: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });
            if (terminalTranscript) {
                const terminalReceipt = terminalTranscript.inputAdmissionReceipt == null
                    ? null
                    : SessionInputAdmissionReceiptV1Schema.safeParse(terminalTranscript.inputAdmissionReceipt);
                if (
                    terminalReceipt !== null
                    && (!terminalReceipt.success || !isSameAdmissionIssuer(terminalReceipt.data, inputAdmissionReceipt))
                    || admission.kind === "machine" && terminalReceipt === null
                ) {
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: "session_input_idempotency_conflict",
                    } as const;
                }
                const expectedPlainEqualityEvidence = derivePlainRequestEqualityEvidence({
                    content,
                    requestedAction,
                });
                const terminalEqualityEvidence = terminalTranscript.requestEqualityEvidenceV1 == null
                    ? null
                    : SessionInputRequestEqualityEvidenceV1Schema.safeParse(terminalTranscript.requestEqualityEvidenceV1);
                if (terminalEqualityEvidence !== null && !terminalEqualityEvidence.success) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                const matchedTerminalPlainEquality = expectedPlainEqualityEvidence !== undefined
                    && terminalEqualityEvidence !== null
                    && isDeepStrictEqual(terminalEqualityEvidence.data, expectedPlainEqualityEvidence);
                const matchedTerminalOpaqueEquality = requestEqualityEvidenceV1?.kind === "e2eeTag"
                    && terminalEqualityEvidence !== null
                    && isDeepStrictEqual(terminalEqualityEvidence.data, requestEqualityEvidenceV1);
                if (
                    expectedPlainEqualityEvidence !== undefined
                    && terminalEqualityEvidence !== null
                    && !matchedTerminalPlainEquality
                    || requestEqualityEvidenceV1 !== undefined && !matchedTerminalOpaqueEquality
                ) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                let existingMessageRole: SessionMessageRole | null;
                if (matchedTerminalPlainEquality || matchedTerminalOpaqueEquality) {
                    existingMessageRole = parseSessionMessageRole(terminalTranscript.messageRole);
                } else {
                    const compatibility = compareSessionMessageContentAndRole({
                        existing: terminalTranscript,
                        candidate: { content, messageRole },
                    });
                    if (compatibility.kind !== "match") {
                        return { ok: false, error: "invalid-params" } as const;
                    }
                    existingMessageRole = compatibility.existingMessageRole;
                }
                return {
                    ok: true,
                    terminal: true,
                    didWrite: false,
                    message: {
                        id: terminalTranscript.id,
                        seq: terminalTranscript.seq,
                        localId: terminalTranscript.localId ?? localId,
                        messageRole: existingMessageRole,
                        content: terminalTranscript.content as PrismaJson.SessionMessageContent,
                        requestedAction,
                        deliveryResolution: parseSessionMessageDeliveryResolutionV1(terminalTranscript.deliveryResolution),
                        createdAt: terminalTranscript.createdAt,
                        updatedAt: terminalTranscript.updatedAt,
                    },
                    pendingCount: session.pendingCount ?? 0,
                    pendingBlockedCount: session.pendingBlockedCount ?? 0,
                    pendingVersion: session.pendingVersion ?? 0,
                    badgeAttentionChanged: false,
                    participantCursors: [],
                } as const;
            }

            const position = await reserveNextPendingQueuePosition(tx, sessionId);

            if (admissionMode === "continuation_if_no_queued_user_input") {
                const queuedUserInput = await tx.sessionPendingMessage.findFirst({
                    where: { sessionId, status: "queued", messageRole: "user" },
                    select: { localId: true },
                });
                if (queuedUserInput) {
                    return {
                        ok: true,
                        suppressed: true,
                        didWrite: false,
                        pendingCount: session.pendingCount ?? 0,
                        pendingBlockedCount: session.pendingBlockedCount ?? 0,
                        pendingVersion: session.pendingVersion ?? 0,
                        badgeAttentionChanged: false,
                        participantCursors: [],
                    } as const;
                }
            }

            const created = await tx.sessionPendingMessage.create({
                data: {
                    sessionId,
                    localId,
                    messageRole,
                    content,
                    requestedAction,
                    status: "queued",
                    deliveryState: deliveryMode === "external_handoff" ? "external_handoff" : undefined,
                    position,
                    authorAccountId: admission.kind === "account" ? actorUserId : null,
                    inputAdmissionReceipt,
                    ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
                },
                select: {
                    localId: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    position: true,
                    createdAt: true,
                    updatedAt: true,
                    discardedAt: true,
                    discardedReason: true,
                    authorAccountId: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                },
            });

            const activationTarget =
                requestedAction.kind === "send_now" && session.active === false
                    ? { accountId: session.accountId, requestId: localId }
                    : undefined;
            const { pendingCount, pendingBlockedCount, pendingVersion, participantCursors, badgeAttentionChanged, meaningfulActivityAt } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: 1,
                meaningfulActivityAt: created.createdAt,
                activationTarget,
            });

            return {
                ok: true,
                didWrite: true,
                pending: mapPendingMessageRow(created),
                pendingCount,
                pendingBlockedCount,
                pendingVersion,
                badgeAttentionChanged,
                participantCursors,
                meaningfulActivityAt,
                ...(activationTarget ? { activationTarget } : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

/**
 * Existing authenticated Machine socket admission. Source/target Machine ids
 * are revalidated transactionally and never copied into Pending/Message facts.
 */
export async function enqueuePendingMessageByAuthenticatedMachine(params: Readonly<{
    accountId: string;
    sourceMachineId: string;
    targetMachineId: string;
    sessionId: string;
    localId: string;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction: PendingRequestedActionV1;
    requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
}>): Promise<SessionInputAdmissionResultV1> {
    const inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.parse({
        v: 1,
        issuer: "authenticatedMachine",
    });
    if (inputAdmissionReceipt.issuer !== "authenticatedMachine") {
        throw new Error("Machine admission receipt parsed to the wrong issuer arm");
    }
    const result = await enqueuePendingMessageWithAdmission({
        actorUserId: params.accountId,
        sessionId: params.sessionId,
        localId: params.localId,
        messageRole: "user",
        content: params.content,
        requestedAction: params.requestedAction,
        ...(params.requestEqualityEvidenceV1
            ? { requestEqualityEvidenceV1: params.requestEqualityEvidenceV1 }
            : {}),
    }, {
        kind: "machine",
        sourceMachineId: params.sourceMachineId,
        targetMachineId: params.targetMachineId,
        inputAdmissionReceipt,
    });

    if (result.ok) {
        return {
            status: result.didWrite ? "accepted" : "alreadyAccepted",
            localId: params.localId,
        };
    }
    if (result.error === "internal") {
        return {
            status: "outcomeUnknown",
            localId: params.localId,
            code: "session_input_admission_outcome_unknown",
        };
    }
    return {
        status: "rejected",
        code: result.admissionRejectionCode
            ?? (result.code
                ? "session_input_encryption_mode_mismatch"
                : result.error === "forbidden"
                    ? "session_input_unauthorized"
                    : result.error === "session-not-found"
                        ? "session_input_target_unavailable"
                        : "session_input_invalid"),
    };
}

export type SettlePendingInputAdmissionResult =
    | Readonly<{
        ok: true;
        result: SessionInputAdmissionResultV1;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursorsPending: ParticipantCursor[];
        participantCursorsMessage: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        message?: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }>
    | Readonly<{
        ok: false;
        error: "forbidden" | "invalid-params" | "not-found" | "conflict" | "internal";
      }>;

function readPlainMessageMeta(content: SessionStoredMessageContent): Record<string, unknown> | null {
    if (content.t !== "plain" || !content.v || typeof content.v !== "object" || Array.isArray(content.v)) return null;
    const meta = (content.v as Record<string, unknown>).meta;
    return meta && typeof meta === "object" && !Array.isArray(meta)
        ? meta as Record<string, unknown>
        : null;
}

function isExactPlainRequestToAuthorityReplacement(params: Readonly<{
    requestContent: SessionStoredMessageContent;
    finalContent: SessionStoredMessageContent;
}>): boolean {
    if (params.requestContent.t !== "plain" || params.finalContent.t !== "plain") return false;
    if (
        !params.requestContent.v
        || typeof params.requestContent.v !== "object"
        || Array.isArray(params.requestContent.v)
        || !params.finalContent.v
        || typeof params.finalContent.v !== "object"
        || Array.isArray(params.finalContent.v)
    ) return false;
    const requestMeta = readPlainMessageMeta(params.requestContent);
    const finalMeta = readPlainMessageMeta(params.finalContent);
    const request = readSessionInputRequestV1(requestMeta);
    const authority = readSessionInputAuthorityV1(finalMeta);
    if (!request || !authority) return false;
    const { permission: requestPermission, ...requestCommon } = request;
    const { permission: authorityPermission, ...authorityCommon } = authority;
    if (
        !isDeepStrictEqual(requestCommon, authorityCommon)
        || requestPermission.requestedPermissionCeiling !== authorityPermission.requestedPermissionCeiling
    ) return false;
    const expected = {
        ...(params.requestContent.v as Record<string, unknown>),
        meta: withSessionInputAuthorityV1(requestMeta ?? {}, authority),
    };
    return isDeepStrictEqual(params.finalContent.v, expected);
}

async function validateInputSettlementDomainFactsInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    validation?: SessionInputSettlementValidationV1;
}>): Promise<
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; rejectionCode?: SessionInputAdmissionRejectionCodeV1 }>
> {
    const sourceSession = params.validation?.sourceSession;
    if (sourceSession) {
        const sourceTurn = await params.tx.sessionTurn.findUnique({
            where: {
                sessionId_turnId: {
                    sessionId: sourceSession.sourceSessionId,
                    turnId: sourceSession.sourceTurnId,
                },
            },
            select: { session: { select: { accountId: true } } },
        });
        if (!sourceTurn || sourceTurn.session.accountId !== params.accountId) return { ok: false };
    }
    const automation = params.validation?.automation;
    if (automation) {
        const run = await params.tx.automationRun.findUnique({
            where: { id: automation.runId },
            select: { accountId: true, automationId: true, state: true },
        });
        if (
            !run
            || run.accountId !== params.accountId
            || run.automationId !== automation.automationId
        ) return { ok: false };
        if (run.state === "cancelled") {
            return { ok: false, rejectionCode: "session_input_cancelled" };
        }
    }
    return { ok: true };
}

/** Target-only protected request settlement, before any Agent/provider effect. */
export async function settlePendingInputAdmission(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    localId: string;
    publisherAuthority: CurrentSessionPublisherAuthority;
    decision:
        | Readonly<{
            kind: "admit";
            finalContent: SessionStoredMessageContent;
            validation?: SessionInputSettlementValidationV1;
          }>
        | Readonly<{
            kind: "reject";
            code: SessionInputAdmissionRejectionCodeV1;
            validation?: SessionInputSettlementValidationV1;
          }>;
}>): Promise<SettlePendingInputAdmissionResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    try {
        return await inTx(async (tx) => {
            if (!await hasExactCurrentPublisherAuthorityInTx(
                tx,
                params.publisherAuthority,
                actorUserId,
                sessionId,
            )) return { ok: false, error: "forbidden" } as const;
            const targetMachine = await tx.machine.findFirst({
                where: { accountId: actorUserId, id: params.publisherAuthority.machineId },
                select: {
                    operationProtocolCapabilities: true,
                    operationProtocolCapabilitiesRevision: true,
                    revokedAt: true,
                    replacedByMachineId: true,
                },
            });
            if (
                !targetMachine
                || targetMachine.revokedAt !== null
                || targetMachine.replacedByMachineId !== null
                || typeof targetMachine.operationProtocolCapabilitiesRevision !== "number"
                || targetMachine.operationProtocolCapabilitiesRevision < 1
                || !supportsMachineOperationProtocolCapabilityV1(
                    targetMachine.operationProtocolCapabilities,
                    "sessionInputAdmission",
                )
            ) return { ok: false, error: "forbidden" } as const;

            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    discardedReason: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    position: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                },
            });
            if (!existing) {
                const committed = await tx.sessionMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId } },
                    select: { id: true, seq: true, localId: true, messageRole: true, content: true, deliveryResolution: true, createdAt: true, updatedAt: true },
                });
                const state = await readCurrentPendingMutationState(tx, sessionId);
                if (!committed) return { ok: false, error: "not-found" } as const;
                return {
                    ok: true,
                    result: { status: "alreadyAccepted", localId },
                    ...state,
                    participantCursorsPending: state.participantCursors,
                    participantCursorsMessage: [],
                    message: {
                        ...committed,
                        localId: committed.localId ?? localId,
                        messageRole: parseSessionMessageRole(committed.messageRole),
                        content: committed.content as PrismaJson.SessionMessageContent,
                        deliveryResolution: parseSessionMessageDeliveryResolutionV1(committed.deliveryResolution),
                    },
                } as const;
            }
            if (existing.status === "discarded") {
                const rejection = SessionInputAdmissionRejectionCodeV1Schema.safeParse(existing.discardedReason);
                if (!rejection.success) return { ok: false, error: "conflict" } as const;
                const state = await readCurrentPendingMutationState(tx, sessionId);
                return {
                    ok: true,
                    result: { status: "rejected", code: rejection.data },
                    ...state,
                    participantCursorsPending: state.participantCursors,
                    participantCursorsMessage: [],
                } as const;
            }
            if (existing.deliveryState !== "delivering") return { ok: false, error: "conflict" } as const;
            const receipt = SessionInputAdmissionReceiptV1Schema.safeParse(existing.inputAdmissionReceipt);
            if (!receipt.success) return { ok: false, error: "conflict" } as const;
            const domainValidation = await validateInputSettlementDomainFactsInTx({
                tx,
                accountId: actorUserId,
                ...(params.decision.validation ? { validation: params.decision.validation } : {}),
            });
            if (!domainValidation.ok && !domainValidation.rejectionCode) {
                return { ok: false, error: "conflict" } as const;
            }
            const decision = !domainValidation.ok && domainValidation.rejectionCode
                ? {
                    kind: "reject" as const,
                    code: domainValidation.rejectionCode,
                    ...(params.decision.validation ? { validation: params.decision.validation } : {}),
                }
                : params.decision;
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { accountId: true, encryptionMode: true },
            });
            if (!session || session.accountId !== actorUserId) return { ok: false, error: "not-found" } as const;
            const requestContent = existing.content as PrismaJson.SessionPendingMessageContent;
            const requestedAction = PendingRequestedActionV1Schema.safeParse(existing.requestedAction);
            if (!requestedAction.success) return { ok: false, error: "conflict" } as const;

            if (decision.kind === "reject") {
                let requestEqualityEvidenceV1: SessionInputRequestEqualityEvidenceV1;
                if (requestContent.t === "plain") {
                    const derived = derivePlainRequestEqualityEvidence({
                        content: requestContent,
                        requestedAction: requestedAction.data,
                    });
                    if (!derived) return { ok: false, error: "conflict" } as const;
                    requestEqualityEvidenceV1 = derived;
                } else {
                    const parsed = SessionInputRequestEqualityEvidenceV1Schema.safeParse(
                        existing.requestEqualityEvidenceV1,
                    );
                    if (!parsed.success || parsed.data.kind !== "e2eeTag") {
                        return { ok: false, error: "conflict" } as const;
                    }
                    requestEqualityEvidenceV1 = parsed.data;
                }
                const discardedFields = pendingDeliveryStatusV1ToPersistedFields({
                    status: "discarded",
                    reason: decision.code,
                });
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: {
                        ...discardedFields,
                        discardedAt: new Date(),
                        requestEqualityEvidenceV1,
                    },
                });
                const state = await applyPendingSessionStateChange({
                    tx,
                    sessionId,
                    pendingCountDelta: -1,
                });
                return {
                    ok: true,
                    result: { status: "rejected", code: decision.code },
                    ...state,
                    participantCursorsPending: state.participantCursors,
                    participantCursorsMessage: [],
                } as const;
            }

            const finalContent = decision.finalContent as PrismaJson.SessionMessageContent;
            if (
                requestContent.t !== finalContent.t
                || requestContent.t === "plain"
                    && !isExactPlainRequestToAuthorityReplacement({ requestContent, finalContent })
            ) return { ok: false, error: "conflict" } as const;
            const policy = readEncryptionFeatureEnv(process.env);
            const sessionEncryptionMode = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const committed = await createSessionMessageFromPending(tx, {
                sessionId,
                sessionEncryptionMode,
                storagePolicy: policy.storagePolicy,
                localId,
                requestContentForEquality: requestContent,
                content: finalContent,
                messageRole: "user",
                pendingRequestedAction: requestedAction.data,
                inputAdmissionReceipt: receipt.data,
                ...(existing.requestEqualityEvidenceV1 == null
                    ? {}
                    : { requestEqualityEvidenceV1: existing.requestEqualityEvidenceV1 }),
            });
            if (!committed.ok) return { ok: false, error: "conflict" } as const;
            const readyProjection = committed.didWrite
                ? await updateSessionMessageActivityProjection(tx, {
                    sessionId,
                    created: committed.message,
                    trustedSessionEventType: resolveReadyProjectionEventType({
                        actorUserId,
                        sessionOwnerId: session.accountId,
                        content: finalContent,
                    }),
                })
                : undefined;
            await tx.sessionPendingMessage.delete({
                where: { sessionId_localId: { sessionId, localId } },
            });
            const state = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: -1,
                meaningfulActivityAt: committed.didWrite ? committed.message.createdAt : undefined,
            });
            const participantCursorsMessage = committed.didWrite || committed.didUpdate
                ? await markSessionParticipantsChanged({
                    tx,
                    sessionId,
                    hint: { lastMessageSeq: committed.message.seq, lastMessageId: committed.message.id },
                })
                : [];
            return {
                ok: true,
                result: { status: "accepted", localId },
                ...state,
                participantCursorsPending: state.participantCursors,
                participantCursorsMessage,
                message: committed.message,
                ...(readyProjection ? { readyProjection } : {}),
            } as const;
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdatePendingMessageResult =
    | { ok: true; localId: string; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "local-id-conflict" | "pending-mutation-conflict" | "delivery-settlement-conflict" | "internal"; code?: EncryptionPolicyRejectionCode };

export type UpdatePendingRequestedActionResult =
    | {
        ok: true;
        didUpdate: boolean;
        requestedAction: PendingRequestedActionV1;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
      }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "action-conflict" | "internal" };

export async function updatePendingRequestedAction(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    localId: string;
    requestedAction: PendingRequestedActionV1;
}>): Promise<UpdatePendingRequestedActionResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const requestedActionResult = PendingRequestedActionV1Schema.safeParse(params.requestedAction);
    if (!actorUserId || !sessionId || !localId || !requestedActionResult.success) {
        return { ok: false, error: "invalid-params" };
    }
    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        // Freeze the request's observed revision before transaction acquisition. `inTx` may
        // replay its callback after a serialization/SQLite conflict; rereading inside that
        // callback would silently reinterpret a stale writer as a fresh/idempotent writer.
        const existing = await db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId, localId } },
            select: {
                status: true,
                deliveryState: true,
                deliveryBlockedReason: true,
                providerAction: true,
                requestedAction: true,
                updatedAt: true,
            },
        });
        if (!existing) return { ok: false, error: "not-found" } as const;
        const currentActionResult = PendingRequestedActionV1Schema.safeParse(
            existing.requestedAction ?? { v: 1, kind: "enqueue" },
        );
        if (!currentActionResult.success) return { ok: false, error: "invalid-params" } as const;
        const currentAction = currentActionResult.data;
        const canReplaceQueued = existing.status === "queued" && existing.deliveryState === null;
        const canReplaceBlocked = existing.status === "queued"
            && existing.deliveryState === "blocked"
            && !isPendingDeliveryProviderEffectPossibleV1(normalizePendingDeliveryStatusV1({
                status: existing.status,
                deliveryState: existing.deliveryState,
                deliveryBlockedReason: existing.deliveryBlockedReason,
            }));
        if (!canReplaceQueued && !canReplaceBlocked) {
            return { ok: false, error: "action-conflict" } as const;
        }
        const frozenWhere = {
            sessionId,
            localId,
            status: "queued" as const,
            deliveryState: canReplaceBlocked ? "blocked" as const : null,
            deliveryBlockedReason: existing.deliveryBlockedReason,
            providerAction: existing.providerAction,
            updatedAt: existing.updatedAt,
            ...(existing.requestedAction === null
                ? {}
                : { requestedAction: { equals: existing.requestedAction } }),
        };
        const nextUpdatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));

        return await inTx(async (tx) => {
            if (!canReplaceBlocked && existing.providerAction === null && isDeepStrictEqual(currentAction, requestedActionResult.data)) {
                const retained = await tx.sessionPendingMessage.count({ where: frozenWhere });
                if (retained !== 1) {
                    return { ok: false, error: "action-conflict" } as const;
                }
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                if (!session) return { ok: false, error: "session-not-found" } as const;
                return {
                    ok: true,
                    didUpdate: false,
                    requestedAction: currentAction,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                    participantCursors: [] as ParticipantCursor[],
                } as const;
            }
            const updatedCount = (await tx.sessionPendingMessage.updateMany({
                where: frozenWhere,
                data: {
                    ...pendingRequestedActionReplacementData(requestedActionResult.data, nextUpdatedAt),
                },
            })).count;
            if (updatedCount !== 1) {
                return { ok: false, error: "action-conflict" } as const;
            }
            const pendingCount = await tx.sessionPendingMessage.count({ where: { sessionId, status: "queued" } });
            const pendingBlockedCount = await tx.sessionPendingMessage.count({
                where: { sessionId, status: "queued", deliveryState: "blocked" },
            });
            const session = await tx.session.update({
                where: { id: sessionId },
                data: { pendingCount, pendingBlockedCount, pendingVersion: { increment: 1 } },
                select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });
            const participantCursors = await markPendingStateChangedParticipants({
                tx,
                sessionId,
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
                pendingVersion: session.pendingVersion,
            });
            return {
                ok: true,
                didUpdate: true,
                requestedAction: requestedActionResult.data,
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
                pendingVersion: session.pendingVersion,
                participantCursors,
            } as const;
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function updatePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    /**
     * A daemon-prepared changed attachment snapshot needs a new admission
     * identity. Rotate the existing row in this transaction so its queue
     * position and durable row id remain unchanged.
     */
    replacementLocalId?: string;
    /**
     * Canonical admitted payload digest for the one response-loss rejoin
     * associated with replacementLocalId. This is not a Message identity.
     */
    replacementMutationFingerprint?: string;
    messageRole?: unknown;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
)): Promise<UpdatePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const replacementLocalId = typeof params.replacementLocalId === "undefined"
        ? null
        : readPendingLocalId(params.replacementLocalId);
    const replacementMutationFingerprint = typeof params.replacementMutationFingerprint === "undefined"
        ? null
        : PendingMessageMutationFingerprintV1Schema.safeParse(params.replacementMutationFingerprint);
    const replacementMutationFingerprintValue = replacementMutationFingerprint?.success
        ? replacementMutationFingerprint.data
        : null;
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const content =
        "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionPendingMessageContent) : null;

    const requestsReplacement = params.replacementLocalId !== undefined || params.replacementMutationFingerprint !== undefined;
    if (
        !actorUserId
        || !sessionId
        || !localId
        || !content
        || requestsReplacement
            && (
                !replacementLocalId
                || replacementLocalId === localId
                || replacementMutationFingerprintValue === null
            )
    ) {
        return { ok: false, error: "invalid-params" };
    }
    if (content.t === "encrypted" && (!content.c || typeof content.c !== "string")) return { ok: false, error: "invalid-params" };
    if (content.t === "plain" && !("v" in content)) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: {
                    encryptionMode: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                },
            });
            if (!session) return { ok: false, error: "session-not-found" } as const;

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: params.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-message",
                },
            }).messageRole;
            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            const policy = readEncryptionFeatureEnv(process.env);
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return {
                    ok: false,
                    error: "invalid-params",
                    code: resolveEncryptionWriteRejectionCode({
                        storagePolicy: policy.storagePolicy,
                        sessionEncryptionMode,
                        writeKind,
                    }),
                } as const;
            }

            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    id: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                },
            });
            if (!existing) {
                if (!replacementLocalId || replacementMutationFingerprintValue === null) {
                    return { ok: false, error: "not-found" } as const;
                }
                const replayed = await tx.sessionPendingMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId: replacementLocalId } },
                    select: {
                        status: true,
                        deliveryState: true,
                        deliveryBlockedReason: true,
                        predecessorLocalId: true,
                        replacementMutationFingerprint: true,
                    },
                });
                if (
                    !replayed
                    || isOrdinaryPendingMutationFenced(replayed)
                    || replayed.predecessorLocalId !== localId
                    || replayed.replacementMutationFingerprint !== replacementMutationFingerprintValue
                ) {
                    return { ok: false, error: "pending-mutation-conflict" } as const;
                }
                return {
                    ok: true,
                    localId: replacementLocalId,
                    pendingVersion: session.pendingVersion ?? 0,
                    pendingCount: session.pendingCount ?? 0,
                    pendingBlockedCount: session.pendingBlockedCount ?? 0,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                } as const;
            }
            if (isOrdinaryPendingMutationFenced(existing)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            if (replacementLocalId) {
                const replacementCollision = await tx.sessionPendingMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId: replacementLocalId } },
                    select: { id: true },
                });
                if (replacementCollision) return { ok: false, error: "local-id-conflict" } as const;
            }

            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    content,
                    messageRole,
                    ...(replacementLocalId
                        ? {
                            localId: replacementLocalId,
                            predecessorLocalId: localId,
                            replacementMutationFingerprint: replacementMutationFingerprintValue,
                        }
                        : {
                            predecessorLocalId: null,
                            replacementMutationFingerprint: null,
                        }),
                },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return {
                ok: true,
                localId: replacementLocalId ?? localId,
                pendingVersion,
                pendingCount,
                pendingBlockedCount,
                participantCursors,
                badgeAttentionChanged,
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DeletePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "delivery-settlement-conflict" | "internal" };

export async function deletePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<DeletePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });

            if (!existing) {
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    pendingBlockedCount: session?.pendingBlockedCount ?? 0,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                };
            }
            if (isOrdinaryPendingMutationFenced(existing)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (existing.status === "discarded" && isPendingDeliveryArchivedUncertaintyReasonV1(existing.discardedReason)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            await tx.sessionPendingMessage.delete({
                where: { sessionId_localId: { sessionId, localId } },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: existing.status === "queued" ? -1 : 0,
                pendingBlockedCountDelta: existing.status === "queued" && existing.deliveryState === "blocked" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

type PendingMutationState = {
    pendingVersion: number;
    pendingCount: number;
    pendingBlockedCount: number;
    participantCursors: ParticipantCursor[];
    badgeAttentionChanged: boolean;
};

async function readCurrentPendingMutationState(tx: Tx, sessionId: string): Promise<PendingMutationState> {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
    });
    return {
        pendingVersion: session?.pendingVersion ?? 0,
        pendingCount: session?.pendingCount ?? 0,
        pendingBlockedCount: session?.pendingBlockedCount ?? 0,
        participantCursors: [],
        badgeAttentionChanged: false,
    };
}

export type ResolveAcceptedPendingDeliveryResult =
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
        participantCursorsPending?: ParticipantCursor[];
        participantCursorsMessage?: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        didResolve: boolean;
        didWrite?: boolean;
        didUpdate?: boolean;
        message?: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: false;
        error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "not-materialized" | "blocked-by-earlier-pending" | "transcript-conflict" | "internal";
        pendingStateChanged?: boolean;
        pendingVersion?: number;
        pendingCount?: number;
        pendingBlockedCount?: number;
        participantCursors?: ParticipantCursor[];
        badgeAttentionChanged?: boolean;
      }
    | { ok: false; error: "transaction-unavailable"; retryAfterMs: number; correlationId?: string };

type PendingDeliveryResolutionInput = Readonly<{
    status: string;
    deliveryState: string | null;
    deliveryBlockedReason: string | null;
    discardedReason?: string | null;
    messageRole: string | null;
    content: unknown;
    requestedAction: unknown;
    position: number;
    inputAdmissionReceipt?: unknown;
    requestEqualityEvidenceV1?: unknown;
}>;

type PendingDeliveryBlockRowInput = Readonly<{
    localId: string;
    status: string;
    deliveryState: string | null;
    deliveryBlockedReason?: string | null;
    discardedReason?: string | null;
}>;

type PendingDeliveryPersistedFieldsInput = Readonly<{
    status: string;
    deliveryState: string | null;
    deliveryBlockedReason?: string | null;
    discardedReason?: string | null;
}>;

function readPendingDeliveryStatus(fields: PendingDeliveryPersistedFieldsInput): PendingDeliveryStatusV1 {
    return normalizePendingDeliveryStatusV1({
        status: fields.status,
        deliveryState: fields.deliveryState,
        deliveryBlockedReason: fields.deliveryBlockedReason ?? null,
        discardedReason: fields.discardedReason ?? null,
    });
}

function canTransitionPendingDeliveryStatus(
    fields: PendingDeliveryPersistedFieldsInput,
    target: PendingDeliveryStatusTransitionTargetV1,
): boolean {
    return isPendingDeliveryStatusTransitionAllowedV1(readPendingDeliveryStatus(fields), target);
}

async function markPendingDeliveryRowsBlocked(
    tx: PendingServiceTx,
    params: Readonly<{
        sessionId: string;
        rows: readonly PendingDeliveryBlockRowInput[];
        reason: PendingDeliveryBlockedReason;
    }>,
): Promise<Readonly<{ updatedCount: number; pendingBlockedCountDelta: number }>> {
    const target = { status: "blocked", reason: params.reason } as const;
    const allowedRows = params.rows.filter((row) => isPendingLocalId(row.localId) && canTransitionPendingDeliveryStatus(row, target));
    const localIds = [...new Set(allowedRows.map((row) => row.localId))];
    if (localIds.length === 0) return { updatedCount: 0, pendingBlockedCountDelta: 0 };

    const pendingBlockedCountDelta = allowedRows.filter((row) =>
        readPendingDeliveryStatus(row).status !== "blocked",
    ).length;
    const persisted = pendingDeliveryStatusV1ToPersistedFields(target);
    const updated = await tx.sessionPendingMessage.updateMany({
        where: {
            sessionId: params.sessionId,
            localId: { in: localIds },
            status: "queued",
        },
        data: {
            status: persisted.status,
            deliveryState: persisted.deliveryState,
            deliveryBlockedReason: persisted.deliveryBlockedReason,
            discardedReason: persisted.discardedReason,
        },
    });

    return {
        updatedCount: updated.count,
        pendingBlockedCountDelta,
    };
}

async function commitResolvedPendingDelivery(
    tx: PendingServiceTx,
    params: Readonly<{
        actorUserId: string;
        sessionId: string;
        localId: string;
        existing: PendingDeliveryResolutionInput;
        target: Extract<PendingDeliveryStatusTransitionTargetV1, { status: "resolved" }>;
    }>,
): Promise<
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
        participantCursorsPending: ParticipantCursor[];
        participantCursorsMessage: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        didWrite: boolean;
        didUpdate: boolean;
        message: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | { ok: false; error: "session-not-found" | "invalid-params" }
    | {
        ok: false;
        error: "transcript-conflict";
        pendingStateChanged: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
        badgeAttentionChanged: boolean;
      }
> {
    if (!canTransitionPendingDeliveryStatus(params.existing, params.target)) {
        return { ok: false, error: "invalid-params" };
    }

    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, encryptionMode: true },
    });
    if (!session) return { ok: false, error: "session-not-found" };

    const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
    const content = params.existing.content as PrismaJson.SessionPendingMessageContent;
    const messageRole = resolveSessionMessageRole({
        content,
        suppliedRole: params.existing.messageRole,
        telemetry: {
            sessionId: params.sessionId,
            storageMode: sessionEncryptionMode,
            source: "pending-materialization",
        },
    }).messageRole;
    const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
    const policy = readEncryptionFeatureEnv(process.env);
    if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
        return { ok: false, error: "invalid-params" };
    }
    const inputAdmissionReceipt = params.existing.inputAdmissionReceipt == null
        ? undefined
        : SessionInputAdmissionReceiptV1Schema.safeParse(params.existing.inputAdmissionReceipt);
    const requestEqualityEvidenceV1 = params.existing.requestEqualityEvidenceV1 == null
        ? undefined
        : SessionInputRequestEqualityEvidenceV1Schema.safeParse(params.existing.requestEqualityEvidenceV1);
    if (
        inputAdmissionReceipt !== undefined && !inputAdmissionReceipt.success
        || requestEqualityEvidenceV1 !== undefined && !requestEqualityEvidenceV1.success
    ) {
        return { ok: false, error: "invalid-params" };
    }

    const committed = await createSessionMessageFromPending(tx, {
        sessionId: params.sessionId,
        sessionEncryptionMode,
        storagePolicy: policy.storagePolicy,
        localId: params.localId,
        content,
        messageRole,
        pendingRequestedAction: params.existing.requestedAction,
        ...(inputAdmissionReceipt === undefined
            ? {}
            : { inputAdmissionReceipt: inputAdmissionReceipt.data }),
        ...(requestEqualityEvidenceV1 === undefined
            ? {}
            : { requestEqualityEvidenceV1: requestEqualityEvidenceV1.data }),
        ...(params.target.reason === "manual_handled"
            ? { deliveryResolution: { v: 1, kind: "manual_handled" } as const }
            : {}),
    });
    if (!committed.ok) {
        if (committed.error === "storage-mode-conflict") {
            return { ok: false, error: "invalid-params" };
        }
        const blocked = await markPendingDeliveryRowsBlocked(tx, {
            sessionId: params.sessionId,
            rows: [{
                localId: params.localId,
                status: params.existing.status,
                deliveryState: params.existing.deliveryState,
                deliveryBlockedReason: params.existing.deliveryBlockedReason,
                discardedReason: params.existing.discardedReason,
            }],
            reason: "unknown",
        });
        const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
            tx,
            sessionId: params.sessionId,
            pendingBlockedCountDelta: blocked.pendingBlockedCountDelta,
        });
        return {
            ok: false,
            error: committed.error,
            pendingStateChanged: true,
            pendingVersion,
            pendingCount,
            pendingBlockedCount,
            participantCursors,
            badgeAttentionChanged,
        };
    }
    const readyProjection = committed.didWrite
        ? await updateSessionMessageActivityProjection(tx, {
            sessionId: params.sessionId,
            created: committed.message,
            trustedSessionEventType: resolveReadyProjectionEventType({
                actorUserId: params.actorUserId,
                sessionOwnerId: session.accountId,
                content,
            }),
        })
        : undefined;

    await tx.sessionPendingMessage.delete({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
    });

    const previousDeliveryStatus = readPendingDeliveryStatus(params.existing);
    const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
        tx,
        sessionId: params.sessionId,
        pendingCountDelta: previousDeliveryStatus.status === "discarded" ? 0 : -1,
        pendingBlockedCountDelta: previousDeliveryStatus.status === "blocked" ? -1 : 0,
        meaningfulActivityAt: committed.didWrite ? committed.message.createdAt : undefined,
    });
    const participantCursorsMessage = committed.didWrite || committed.didUpdate
        ? await markSessionParticipantsChanged({
            tx,
            sessionId: params.sessionId,
            hint: { lastMessageSeq: committed.message.seq, lastMessageId: committed.message.id },
        })
        : [];

    return {
        ok: true,
        pendingVersion,
        pendingCount,
        pendingBlockedCount,
        participantCursors,
        participantCursorsPending: participantCursors,
        participantCursorsMessage,
        badgeAttentionChanged,
        didWrite: committed.didWrite,
        didUpdate: committed.didUpdate,
        message: committed.message,
        ...(readyProjection ? { readyProjection } : {}),
    };
}

export async function resolveAcceptedPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    publisherAuthority: CurrentSessionPublisherAuthority;
    diagnosticCorrelationId?: string;
}): Promise<ResolveAcceptedPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    if (!actorUserId || !sessionId || !localId) {
        return { ok: false, error: "invalid-params" };
    }

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await rejoinPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            if (!await hasExactCurrentPublisherAuthorityInTx(
                tx,
                params.publisherAuthority,
                actorUserId,
                sessionId,
            )) {
                return { ok: false, error: "forbidden" } as const;
            }
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    discardedReason: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    position: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                },
            });

            if (!existing) {
                const committed = await tx.sessionMessage.findFirst({
                    where: {
                        sessionId,
                        localId,
                        OR: [
                            { messageRole: "user" },
                            { messageRole: null },
                        ],
                    },
                    select: { id: true, seq: true, localId: true, messageRole: true, content: true, deliveryResolution: true, createdAt: true, updatedAt: true },
                });
                if (!committed) {
                    return { ok: false, error: "not-found" } as const;
                }

                return {
                    ok: true,
                    ...(await readCurrentPendingMutationState(tx, sessionId)),
                    didResolve: false,
                    message: {
                        id: committed.id,
                        seq: committed.seq,
                        localId: committed.localId ?? localId,
                        messageRole: parseSessionMessageRole(committed.messageRole),
                        content: committed.content as PrismaJson.SessionMessageContent,
                        deliveryResolution: parseSessionMessageDeliveryResolutionV1(committed.deliveryResolution),
                        createdAt: committed.createdAt,
                        updatedAt: committed.updatedAt,
                    },
                } as const;
            }

            if (!canTransitionPendingDeliveryStatus(existing, { status: "resolved", reason: "provider_accepted" })) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didResolve: false };
            }

            const requestedAction = PendingRequestedActionV1Schema.safeParse(existing.requestedAction);
            const isExactAction = requestedAction.success && requestedAction.data.kind !== "enqueue";
            const earlierUnresolved = isExactAction ? null : await tx.sessionPendingMessage.findFirst({
                where: {
                    sessionId,
                    status: "queued",
                    position: { lt: existing.position },
                },
                select: { localId: true },
            });
            if (earlierUnresolved) {
                return { ok: false, error: "blocked-by-earlier-pending" } as const;
            }

            const resolved = await commitResolvedPendingDelivery(tx, {
                actorUserId,
                sessionId,
                localId,
                existing,
                target: { status: "resolved", reason: "provider_accepted" },
            });
            if (!resolved.ok) return resolved;
            return { ...resolved, didResolve: true };
        }));
    } catch (error) {
        if (isTransactionAcquisitionUnavailableError(error)) {
            warn(
                {
                    module: "session-pending-service",
                    operation: "provider-acceptance",
                    sessionId,
                    localId,
                    correlationId: params.diagnosticCorrelationId ?? null,
                    prismaCode: "P2028",
                    err: error,
                },
                "pending delivery transaction acquisition failed",
            );
            return {
                ok: false,
                error: "transaction-unavailable",
                retryAfterMs: 1_000,
                ...(params.diagnosticCorrelationId ? { correlationId: params.diagnosticCorrelationId } : {}),
            };
        }
        return { ok: false, error: "internal" };
    }
}

export type BlockPendingDeliveryResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; didUpdate: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function blockPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    reason: PendingDeliveryBlockedReason;
}): Promise<BlockPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const reason = normalizePendingDeliveryBlockedReason(params.reason);

    if (!actorUserId || !sessionId || !localId || !reason) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    discardedReason: true,
                    requestedAction: true,
                    providerAction: true,
                    updatedAt: true,
                },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (reason === "conditional_steer_unavailable") {
                const requestedAction = PendingRequestedActionV1Schema.safeParse(existing.requestedAction);
                if (
                    existing.status === "queued"
                    && existing.deliveryState === null
                    && existing.deliveryBlockedReason === null
                    && existing.providerAction === null
                    && requestedAction.success
                    && requestedAction.data.kind === "enqueue"
                ) {
                    return {
                        ok: true,
                        ...(await readCurrentPendingMutationState(tx, sessionId)),
                        didUpdate: false,
                    } as const;
                }
                if (
                    existing.status !== "queued"
                    || existing.deliveryState !== "delivering"
                    || !requestedAction.success
                    || !isConditionalPendingSteerClaim({
                        requestedAction: requestedAction.data,
                        providerAction: existing.providerAction,
                    })
                ) {
                    return { ok: false, error: "delivery-settlement-conflict" } as const;
                }
                const nextUpdatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
                const updated = await tx.sessionPendingMessage.updateMany({
                    where: {
                        sessionId,
                        localId,
                        status: "queued",
                        deliveryState: "delivering",
                        deliveryBlockedReason: existing.deliveryBlockedReason,
                        providerAction: "steer",
                        updatedAt: existing.updatedAt,
                    },
                    data: pendingRequestedActionReplacementData(
                        { v: 1, kind: "enqueue" },
                        nextUpdatedAt,
                    ),
                });
                if (updated.count !== 1) {
                    return { ok: false, error: "delivery-settlement-conflict" } as const;
                }
                const state = await applyPendingSessionStateChange({ tx, sessionId });
                return { ok: true, ...state, didUpdate: true } as const;
            }
            const target = { status: "blocked", reason } as const;
            if (!canTransitionPendingDeliveryStatus(existing, target)) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false };
            }
            if (existing.deliveryState === "blocked" && existing.deliveryBlockedReason === reason) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false };
            }

            const persisted = pendingDeliveryStatusV1ToPersistedFields(target);
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: persisted.status,
                    deliveryState: persisted.deliveryState,
                    deliveryBlockedReason: persisted.deliveryBlockedReason,
                    discardedReason: persisted.discardedReason,
                },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingBlockedCountDelta: readPendingDeliveryStatus(existing).status === "blocked" ? 0 : 1,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged, didUpdate: true };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type SendPendingDeliveryAsNewResult =
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        didWrite: boolean;
        newLocalId: string;
      }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "identity-conflict" | "internal" };

function derivePendingSendAsNewLocalId(sessionId: string, localId: string): string {
    const digest = createHash("sha256")
        .update(`happier.pending.send-as-new.v1\0${sessionId}\0${localId}`, "utf8")
        .digest("hex");
    return `send-as-new-${digest}`;
}

export async function sendPendingDeliveryAsNew(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<SendPendingDeliveryAsNewResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) {
        return { ok: false, error: "invalid-params" };
    }
    const newLocalId = derivePendingSendAsNewLocalId(sessionId, localId);

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    discardedReason: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    authorAccountId: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            const existingStatus = readPendingDeliveryStatus(existing);

            const replacement = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId: newLocalId } },
                select: { status: true, deliveryState: true, messageRole: true, content: true, requestedAction: true },
            });
            const replacementAction = { v: 1, kind: "enqueue" } as const;
            if (existingStatus.status === "discarded" && existingStatus.reason === "resent_as_new") {
                if (
                    replacement
                    && replacement.status === "queued"
                    && replacement.deliveryState === null
                    && replacement.messageRole === existing.messageRole
                    && isDeepStrictEqual(replacement.content, existing.content)
                    && isDeepStrictEqual(normalizePendingRequestedActionV1(replacement.requestedAction), replacementAction)
                ) {
                    return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didWrite: false, newLocalId };
                }
                return { ok: false, error: "identity-conflict" } as const;
            }
            if (existingStatus.status !== "blocked" || !isPendingDeliveryProviderEffectPossibleV1(existingStatus)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (replacement) return { ok: false, error: "identity-conflict" } as const;
            const transcriptCollision = await tx.sessionMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId: newLocalId } },
                select: { id: true },
            });
            if (transcriptCollision) return { ok: false, error: "identity-conflict" } as const;

            const position = await reserveNextPendingQueuePosition(tx, sessionId);
            const persisted = pendingDeliveryStatusV1ToPersistedFields({ status: "discarded", reason: "resent_as_new" });
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: persisted.status,
                    deliveryState: persisted.deliveryState,
                    deliveryBlockedReason: persisted.deliveryBlockedReason,
                    discardedReason: persisted.discardedReason,
                    discardedAt: new Date(),
                },
            });
            await tx.sessionPendingMessage.create({
                data: {
                    sessionId,
                    localId: newLocalId,
                    messageRole: existing.messageRole,
                    content: existing.content,
                    requestedAction: replacementAction,
                    status: "queued",
                    position,
                    authorAccountId: existing.authorAccountId ?? actorUserId,
                    ...(existing.inputAdmissionReceipt == null
                        ? {}
                        : { inputAdmissionReceipt: existing.inputAdmissionReceipt }),
                },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingBlockedCountDelta: -1,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged, didWrite: true, newLocalId };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type MarkPendingDeliveryHandledResult =
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
        participantCursorsPending?: ParticipantCursor[];
        participantCursorsMessage?: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        didResolve: boolean;
        didWrite?: boolean;
        didUpdate?: boolean;
        message?: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: false;
        error: "session-not-found" | "forbidden" | "invalid-params" | "transcript-conflict" | "internal";
        pendingStateChanged?: boolean;
        pendingVersion?: number;
        pendingCount?: number;
        pendingBlockedCount?: number;
        participantCursors?: ParticipantCursor[];
        badgeAttentionChanged?: boolean;
      };

export async function markPendingDeliveryHandled(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<MarkPendingDeliveryHandledResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await rejoinPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    discardedReason: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    position: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                },
            });
            if (!existing || !canTransitionPendingDeliveryStatus(existing, { status: "resolved", reason: "manual_handled" })) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didResolve: false };
            }

            const resolved = await commitResolvedPendingDelivery(tx, {
                actorUserId,
                sessionId,
                localId,
                existing,
                target: { status: "resolved", reason: "manual_handled" },
            });
            if (!resolved.ok) return resolved;
            return { ...resolved, didResolve: true };
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DismissPendingDeliveryResult =
    | { ok: true; didDismiss: boolean; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function dismissPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    now?: Date;
}): Promise<DismissPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const now = params.now instanceof Date ? params.now : new Date();
    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await rejoinPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            const status = readPendingDeliveryStatus(existing);
            if (status.status === "discarded" && status.reason === "dismissed_uncertain") {
                return { ok: true, didDismiss: false, ...(await readCurrentPendingMutationState(tx, sessionId)) } as const;
            }
            if (!isPendingDeliveryProviderEffectPossibleV1(status)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            const persisted = pendingDeliveryStatusV1ToPersistedFields({ status: "discarded", reason: "dismissed_uncertain" });
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: persisted.status,
                    deliveryState: persisted.deliveryState,
                    deliveryBlockedReason: persisted.deliveryBlockedReason,
                    discardedAt: now,
                    discardedReason: persisted.discardedReason,
                },
            });
            const state = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: -1,
                pendingBlockedCountDelta: status.status === "blocked" ? -1 : 0,
            });
            return { ok: true, didDismiss: true, ...state } as const;
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DiscardPendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function discardPendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    reason?: string;
    now?: Date;
}): Promise<DiscardPendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const reason = typeof params.reason === "string" ? params.reason : null;
    const now = params.now instanceof Date ? params.now : new Date();

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };
    if (isPendingDeliveryArchivedUncertaintyReasonV1(reason)) {
        return { ok: false, error: "delivery-settlement-conflict" };
    }

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (isOrdinaryPendingMutationFenced(existing)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            const target = { status: "discarded", reason } as const;
            if (readPendingDeliveryStatus(existing).status === "discarded" || !canTransitionPendingDeliveryStatus(existing, target)) {
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    pendingBlockedCount: session?.pendingBlockedCount ?? 0,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                } as const;
            }

            const persisted = pendingDeliveryStatusV1ToPersistedFields(target);
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: persisted.status,
                    deliveryState: persisted.deliveryState,
                    deliveryBlockedReason: persisted.deliveryBlockedReason,
                    discardedAt: now,
                    discardedReason: persisted.discardedReason,
                },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: -1,
                pendingBlockedCountDelta: readPendingDeliveryStatus(existing).status === "blocked" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type RestorePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function restorePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<RestorePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (existing.status === "discarded" && isPendingDeliveryArchivedUncertaintyReasonV1(existing.discardedReason)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (isOrdinaryPendingMutationFenced(existing)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            const target = { status: "queued" } as const;
            if (canTransitionPendingDeliveryStatus(existing, target) && readPendingDeliveryStatus(existing).status === "discarded") {
                const position = await reserveNextPendingQueuePosition(tx, sessionId);
                const persisted = pendingDeliveryStatusV1ToPersistedFields(target);

                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: {
                        status: persisted.status,
                        deliveryState: persisted.deliveryState,
                        deliveryBlockedReason: persisted.deliveryBlockedReason,
                        discardedAt: null,
                        discardedReason: persisted.discardedReason,
                        position,
                    },
                });
            }

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: existing.status === "discarded" ? 1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ReorderPendingMessagesResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "delivery-settlement-conflict" | "internal" };

export async function reorderPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    orderedLocalIds: string[];
}): Promise<ReorderPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const orderedLocalIds = Array.isArray(params.orderedLocalIds) ? params.orderedLocalIds.filter(isPendingLocalId) : [];

    if (!actorUserId || !sessionId || orderedLocalIds.length === 0) return { ok: false, error: "invalid-params" };
    if (new Set(orderedLocalIds).size !== orderedLocalIds.length) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const queued = await tx.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                select: { localId: true, deliveryState: true, deliveryBlockedReason: true, position: true },
                orderBy: { position: "asc" },
            });
            const queuedIds = queued.map((v) => v.localId);
            if (queuedIds.length !== orderedLocalIds.length) return { ok: false, error: "invalid-params" } as const;

            const a = new Set(queuedIds);
            for (const id of orderedLocalIds) {
                if (!a.has(id)) return { ok: false, error: "invalid-params" } as const;
            }
            const queuedByLocalId = new Map(queued.map((row) => [row.localId, row]));
            const orderedIndexByLocalId = new Map(orderedLocalIds.map((localId, index) => [localId, index]));
            for (let existingIndex = 0; existingIndex < queued.length; existingIndex++) {
                const row = queued[existingIndex];
                if (
                    isOrdinaryPendingMutationFenced({ status: "queued", ...row })
                    && orderedIndexByLocalId.get(row.localId) !== existingIndex
                ) {
                    return { ok: false, error: "delivery-settlement-conflict" } as const;
                }
            }

            let position = 1;
            for (const localId of orderedLocalIds) {
                const row = queuedByLocalId.get(localId);
                if (
                    (row && isOrdinaryPendingMutationFenced({ status: "queued", ...row }))
                    || row?.position === position
                ) {
                    position++;
                    continue;
                }
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: { position },
                });
                position++;
            }

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type { MaterializeNextPendingMessageResult } from "@/app/session/pending/materializeNextPendingMessage";
export {
    mapPendingMaterializationError,
    materializeNextPendingMessage,
    materializeNextPendingMessageInTx,
} from "@/app/session/pending/materializeNextPendingMessage";
