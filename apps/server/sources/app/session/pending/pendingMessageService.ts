import { buildSessionInputAdmissionReceipt, isSameSessionInputAdmissionIssuer } from "@/app/session/messages/sessionInputAdmission";
import { markSessionProjectionRecipientsChanged, type SessionRecipientCursor } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import { markPendingStateChangedRecipients } from "@/app/session/pending/markPendingStateChangedRecipients";
import { reconcileSessionPendingQueueStateInTx } from "@/app/session/pending/reconcileSessionPendingQueueState";
import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import { mapPendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";
import {
    assertSessionCapabilityInTx,
    assertSessionOwnerInTx,
    resolveEffectiveSessionAccess,
    resolveStructuralSessionAccess,
    resolveSessionAccessForOperation,
} from "@/app/session/access/sessionAccess";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import type { CallerInputConstraintsV1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import type { PendingMessageRow, PendingMessageRowRaw } from "@/app/session/pending/mapPendingMessageRow";
import { projectSessionMessageAccountActors } from "@/app/session/messages/projectSessionMessageAccountActors";
import { db, getActivePrismaRuntime } from "@/storage/db";
import { afterTx, inTx, isTransactionAcquisitionUnavailableError, type Tx } from "@/storage/inTx";
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
    deriveSessionMessageAuthorAccountIdV1,
    SessionInputAdmissionRejectionCodeV1Schema,
    SessionInputRequestEqualityEvidenceV1Schema,
    SESSION_MESSAGE_PROVENANCE_META_KEY,
    supportsMachineOperationProtocolCapabilityV1,
    supportsMachineSessionInputAdmissionProtocolVersion,
    ExecutionRunIdSchema,
    SessionIdSchema,
    SidechainIdSchema,
    readParticipantRecipientRoutingIdentityV1,
    readSessionInputAuthority,
    readSessionInputRequest,
    settleSessionInputRequestV1,
    settleSessionInputRequestV2,
    settleSessionMessageProvenanceV1,
    settleSessionMessageProvenanceV2,
    withSessionInputAuthority,
    parseSessionMessageDeliveryResolutionV1,
    pendingDeliveryStatusV1ToPersistedFields,
    type PendingDeliveryBlockedReason,
    type PendingActivationFailureCodeV1,
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
    type SessionAccessErrorCodeV1,
} from "@happier-dev/protocol";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { reserveNextPendingQueuePosition } from "@/app/session/pending/reserveNextPendingQueuePosition";
import { parseSessionMessageRole, resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { hasExactCurrentPublisherAuthorityInTx, hasCurrentPublisherTargetAdmissionCapabilityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
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
import {
    armPendingActivationAuthorizationInTx,
    markPendingActivationAuthorizationFailedInTx,
    reconcilePendingActivationAuthorizationForRemovedRequestInTx,
    shouldArmPendingActivationAuthorization,
    type PendingActivationTarget,
} from "@/app/session/pending/pendingActivationAuthorization";
import { emitPendingChanged } from "@/app/session/pending/publishPendingMutation";

type RecipientCursor = SessionRecipientCursor;

type PendingOperationErrorContext = Readonly<{
    operation: "enqueue" | "provider-acceptance";
    sessionId: string;
    localId: string;
    diagnosticCorrelationId?: string;
    prismaCode?: string;
    error: unknown;
}>;

function reportPendingOperationError(context: PendingOperationErrorContext, message: string): void {
    warn(
        {
            module: "session-pending-service",
            operation: context.operation,
            sessionId: context.sessionId,
            localId: context.localId,
            correlationId: context.diagnosticCorrelationId ?? null,
            ...(context.prismaCode ? { prismaCode: context.prismaCode } : {}),
            err: context.error,
        },
        message,
    );
}

function pendingRequestedActionReplacementData(
    requestedAction: PendingRequestedActionV1,
    updatedAt: Date,
) {
    return {
        requestedAction,
        requestEqualityEvidenceV1: getActivePrismaRuntime().DbNull,
        providerAction: null,
        deliveryState: null,
        deliveryBlockedReason: null,
        updatedAt,
    } as const;
}
type PendingServiceTx = Tx;

function parsePendingExecutionTarget(value: string | null | undefined):
    | { ok: true; targetExecutionRunId: string | null }
    | { ok: false; error: "invalid-params" } {
    if (value == null) return { ok: true, targetExecutionRunId: null };
    const parsed = ExecutionRunIdSchema.safeParse(value);
    return parsed.success
        ? { ok: true, targetExecutionRunId: parsed.data }
        : { ok: false, error: "invalid-params" };
}

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

export type PendingSessionAuthenticationError = Extract<
    SessionAccessErrorCodeV1,
    "session_access_authentication_required" | "session_access_authentication_unavailable"
>;

type PendingSessionAccessError = "session-not-found" | PendingSessionAuthenticationError;

/**
 * Pending is a Session-access consumer. Preserve the canonical credential
 * continuation while keeping ordinary absence/denial indistinguishable from a
 * missing Session.
 */
function projectPendingSessionAccessError(
    status: "authentication_required" | "authentication_unavailable" | "unavailable",
): PendingSessionAccessError {
    if (status === "authentication_required") return "session_access_authentication_required";
    if (status === "authentication_unavailable") return "session_access_authentication_unavailable";
    return "session-not-found";
}

async function projectPendingMessageRows(reader: Pick<Tx, "account">, rows: readonly PendingMessageRowRaw[]): Promise<PendingMessageRow[]> {
    const actors = await projectSessionMessageAccountActors(reader, rows.map((row) => ({
        messageRole: row.messageRole,
        inputAdmissionReceipt: row.inputAdmissionReceipt,
        authorAccountId: row.authorAccountId,
    })));
    return rows.map((row, index) => mapPendingMessageRow(row, actors[index]));
}

export type ListPendingMessagesResult =
    | { ok: true; pending: PendingMessageRow[]; targetPendingState?: TargetPendingState }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "internal" };

export type ReadSessionPendingStateResult =
    | { ok: true; pendingCount: number; pendingBlockedCount: number; pendingVersion: number }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "internal" };

export type QueuedExecutionRunPendingTarget = Readonly<{
    sessionId: string;
    runId: string;
}>;

/** Current owner-scoped recipient projection used by durable Account-change replay. */
export async function listQueuedExecutionRunPendingTargetsForSessions(params: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    reader?: Pick<Tx, "sessionPendingMessage">;
}>): Promise<QueuedExecutionRunPendingTarget[]> {
    if (typeof params.accountId !== "string" || params.accountId.length === 0) return [];
    const sessionIds = [...new Set(params.sessionIds.flatMap((value) => {
        const parsed = SessionIdSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
    }))];
    if (sessionIds.length === 0) return [];

    const rows = await (params.reader ?? db).sessionPendingMessage.findMany({
        where: {
            sessionId: { in: sessionIds },
            session: { is: { accountId: params.accountId } },
            status: "queued",
            targetExecutionRunId: { not: null },
        },
        orderBy: [
            { sessionId: "asc" },
            { position: "asc" },
        ],
        select: {
            sessionId: true,
            targetExecutionRunId: true,
        },
    });
    const seen = new Set<string>();
    return rows.flatMap((row) => {
        const runId = ExecutionRunIdSchema.safeParse(row.targetExecutionRunId);
        if (!runId.success) return [];
        const key = `${row.sessionId}\u0000${runId.data}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ sessionId: row.sessionId, runId: runId.data }];
    });
}

export async function readSessionPendingState(params: {
    actorUserId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
}): Promise<ReadSessionPendingStateResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const decision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
    });
    if (decision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(decision.status) };
    if (decision.access.level !== "owner") return { ok: false, error: "forbidden" };

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
    targetExecutionRunId?: string | null;
    authentication: SessionAccessAuthentication;
}): Promise<ListPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const includeDiscarded = params.includeDiscarded === true;
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const decision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
    });
    if (decision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(decision.status) };

    const select = {
        localId: true,
        targetExecutionRunId: true,
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
    } as const;

    try {
        if (targetExecutionRunId !== null) {
            return await inTx(async (tx) => {
                const [queued, discarded, pendingCount, pendingBlockedCount, session] = await Promise.all([
                    tx.sessionPendingMessage.findMany({
                        where: { sessionId, targetExecutionRunId, status: "queued" },
                        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                        select,
                    }),
                    includeDiscarded
                        ? tx.sessionPendingMessage.findMany({
                            where: {
                                sessionId,
                                status: "discarded",
                                targetExecutionRunId,
                                OR: [
                                    { discardedReason: null },
                                    { discardedReason: { notIn: [...PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1] } },
                                ],
                            },
                            orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
                            select,
                        })
                        : Promise.resolve([]),
                    tx.sessionPendingMessage.count({ where: { sessionId, targetExecutionRunId, status: "queued" } }),
                    tx.sessionPendingMessage.count({
                        where: { sessionId, targetExecutionRunId, status: "queued", deliveryState: "blocked" },
                    }),
                    tx.session.findUnique({ where: { id: sessionId }, select: { pendingVersion: true } }),
                ]);
                if (!session) return { ok: false, error: "session-not-found" } as const;
                return {
                    ok: true,
                    pending: await projectPendingMessageRows(tx, [...queued, ...discarded]),
                    targetPendingState: {
                        pendingCount,
                        pendingBlockedCount,
                        pendingVersion: session.pendingVersion,
                    },
                } as const;
            });
        }

        if (!includeDiscarded) {
            const rows = await db.sessionPendingMessage.findMany({
                where: { sessionId, targetExecutionRunId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select,
            });
            return { ok: true, pending: await projectPendingMessageRows(db, rows) };
        }

        const [queued, discarded] = await Promise.all([
            db.sessionPendingMessage.findMany({
                where: { sessionId, targetExecutionRunId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select,
            }),
            db.sessionPendingMessage.findMany({
                where: {
                    sessionId,
                    status: "discarded",
                    targetExecutionRunId,
                    OR: [
                        { discardedReason: null },
                        { discardedReason: { notIn: [...PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1] } },
                    ],
                },
                orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
                select,
            }),
        ]);

        return { ok: true, pending: await projectPendingMessageRows(db, [...queued, ...discarded]) };
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
        recipientCursors: RecipientCursor[];
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
        recipientCursors: [];
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
        recipientCursors: [];
      }
    | {
        ok: false;
        error: PendingSessionAccessError | "forbidden" | "invalid-params" | "internal";
        code?: EncryptionPolicyRejectionCode;
        admissionRejectionCode?: SessionInputAdmissionRejectionCodeV1;
      }
    | { ok: false; error: "transaction-unavailable"; retryAfterMs: number; correlationId?: string };

type EnqueuePendingMessageInput = {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    targetMachineId?: string;
    localId: string;
    messageRole?: unknown;
    deliveryMode?: "external_handoff";
    admissionMode?: "continuation_if_no_queued_user_input";
    requestedAction: PendingRequestedActionV1;
    resumeWhenAvailable?: true;
    requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
    diagnosticCorrelationId?: string;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
);

type PendingMessageAdmissionContext =
    | Readonly<{
        kind: "account";
        authentication: SessionAccessAuthentication;
      }>
    | Readonly<{
        kind: "machine";
        sourceMachineId: string;
        targetMachineId: string;
        inputAdmissionReceipt: Extract<SessionInputAdmissionReceiptV1, { issuer: "authenticatedMachine" }>;
      }>;

function isAuthenticatedAccountRetryOfHostVerifiedEncryptedBytes(params: Readonly<{
    admission: PendingMessageAdmissionContext;
    actorUserId: string;
    authorAccountId: string | null;
    inputAdmissionReceipt: unknown;
    requestEqualityEvidenceV1: unknown;
    existingContent: PrismaJson.SessionMessageContent;
    candidateContent: PrismaJson.SessionMessageContent;
}>): boolean {
    if (
        params.admission.kind !== "account"
        || params.authorAccountId !== null && params.authorAccountId !== params.actorUserId
        || params.existingContent.t !== "encrypted"
        || params.candidateContent.t !== "encrypted"
        || !isDeepStrictEqual(params.existingContent, params.candidateContent)
    ) {
        return false;
    }
    const receipt = SessionInputAdmissionReceiptV1Schema.safeParse(params.inputAdmissionReceipt);
    const evidence = SessionInputRequestEqualityEvidenceV1Schema.safeParse(params.requestEqualityEvidenceV1);
    return receipt.success
        && receipt.data.issuer === "authenticatedAccount"
        && receipt.data.actorAccountId === params.actorUserId
        && evidence.success
        && evidence.data.kind === "e2eeTag";
}

export async function enqueuePendingMessage(
    params: EnqueuePendingMessageInput & Readonly<{ authentication: SessionAccessAuthentication }>,
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
    const decision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (decision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(decision.status) };
    if (!decision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };
    return await enqueuePendingMessageWithAdmission(params, {
        kind: "account",
        authentication: params.authentication,
    });
}

async function enqueuePendingMessageWithAdmission(
    params: EnqueuePendingMessageInput,
    admission: PendingMessageAdmissionContext,
): Promise<EnqueuePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
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
    const directTokenInput = admission.kind === "account" && admission.authentication.apiTokenGrant !== undefined;
    if (directTokenInput && params.messageRole !== undefined && params.messageRole !== null && params.messageRole !== "user") {
        return { ok: false, error: "invalid-params" };
    }
    if (targetExecutionRunId !== null && (deliveryMode !== undefined || admissionMode !== undefined)) {
        return { ok: false, error: "invalid-params" };
    }
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

    try {
        return await inTx(async (tx) => {
            const access = admission.kind === "account"
                ? await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: admission.authentication })
                : await assertSessionOwnerInTx({ tx, accountId: actorUserId, sessionId });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const inputAdmissionReceipt = admission.kind === "account"
                ? buildSessionInputAdmissionReceipt({ issuer: "authenticatedAccount", access: access.access,
                    callerInputConstraints: admission.authentication.callerInputConstraints ?? admission.authentication.apiTokenGrant })
                : admission.inputAdmissionReceipt;
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
            if (admission.kind === "machine" || targetExecutionRunId !== null) {
                if (admission.kind === "machine" && session.accountId !== actorUserId) {
                    return {
                        ok: false,
                        error: "session-not-found",
                        admissionRejectionCode: "session_input_unauthorized",
                    } as const;
                }
                const targetMachineId = admission.kind === "machine" ? admission.targetMachineId : params.targetMachineId;
                if (!targetMachineId) return {
                    ok: false, error: "session-not-found", admissionRejectionCode: "session_input_target_unavailable",
                } as const;
                const [sourceMachine, targetAccess] = await Promise.all([
                    admission.kind === "machine" ? tx.machine.findFirst({
                        where: { accountId: actorUserId, id: admission.sourceMachineId },
                        select: { revokedAt: true, replacedByMachineId: true },
                    }) : null,
                    tx.accessKey.findUnique({
                        where: {
                            accountId_machineId_sessionId: {
                                accountId: session.accountId,
                                machineId: targetMachineId,
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
                    admission.kind === "machine" && (!sourceMachine
                    || sourceMachine.revokedAt !== null
                    || sourceMachine.replacedByMachineId !== null)
                ) {
                    return {
                        ok: false,
                        error: "forbidden",
                        admissionRejectionCode: "session_input_unauthorized",
                    } as const;
                }
                if (
                    !targetAccess
                    || targetAccess.session.accountId !== session.accountId
                    || targetAccess.machine.revokedAt !== null
                    || targetAccess.machine.replacedByMachineId !== null
                ) {
                    if (targetExecutionRunId !== null) {
                        return {
                            ok: false,
                            error: "session-not-found",
                            admissionRejectionCode: "session_input_target_unavailable",
                        } as const;
                    }
                    return {
                        ok: false,
                        error: "session-not-found",
                        admissionRejectionCode: "session_input_target_unavailable",
                    } as const;
                }
                if (
                    typeof targetAccess.machine.operationProtocolCapabilitiesRevision !== "number"
                    || targetAccess.machine.operationProtocolCapabilitiesRevision < 1
                    || !supportsMachineSessionInputAdmissionProtocolVersion(
                        targetAccess.machine.operationProtocolCapabilities,
                        targetExecutionRunId === null ? 1 : 2,
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
                suppliedRole: directTokenInput ? (content.t === "encrypted" ? "user" : undefined) : params.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-message",
                },
            }).messageRole;
            if (directTokenInput && messageRole !== "user") return { ok: false, error: "invalid-params" } as const;
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
                    targetExecutionRunId: true,
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
                const identityConflict = {
                    ok: false,
                    error: "invalid-params",
                    admissionRejectionCode: "session_input_idempotency_conflict",
                } as const;
                if (existing.targetExecutionRunId !== targetExecutionRunId) {
                    return identityConflict;
                }
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
                    return identityConflict;
                }
                const existingReceipt = existing.inputAdmissionReceipt == null
                    ? null
                    : SessionInputAdmissionReceiptV1Schema.safeParse(existing.inputAdmissionReceipt);
                const matchedAccountAdmissionIssuer = admission.kind === "account"
                    && (existing.authorAccountId === null || existing.authorAccountId === actorUserId)
                    && (existingReceipt === null
                        ? existing.authorAccountId === actorUserId
                        : existingReceipt.success
                            && existingReceipt.data.issuer === "authenticatedAccount"
                            && existingReceipt.data.actorAccountId === actorUserId
                            && isSameSessionInputAdmissionIssuer(existingReceipt.data, inputAdmissionReceipt));
                if (
                    admission.kind === "account"
                        ? !matchedAccountAdmissionIssuer
                        : existing.authorAccountId !== null
                            || existingReceipt === null
                            || !existingReceipt.success
                            || !isSameSessionInputAdmissionIssuer(existingReceipt.data, inputAdmissionReceipt)
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
                const expectedPlainEqualityEvidence = derivePlainRequestEqualityEvidence({
                    content,
                    requestedAction,
                });
                const matchedPlainEquality = expectedPlainEqualityEvidence !== undefined
                    && existingEqualityEvidence !== null
                    && isDeepStrictEqual(existingEqualityEvidence.data, expectedPlainEqualityEvidence);
                const matchedOpaqueEquality = requestEqualityEvidenceV1?.kind === "e2eeTag"
                    && existingEqualityEvidence !== null
                    && isDeepStrictEqual(existingEqualityEvidence.data, requestEqualityEvidenceV1);
                const matchedAccountRetryAfterHostEquality = requestEqualityEvidenceV1 === undefined
                    && isAuthenticatedAccountRetryOfHostVerifiedEncryptedBytes({
                        admission,
                        actorUserId,
                        authorAccountId: existing.authorAccountId,
                        inputAdmissionReceipt: existing.inputAdmissionReceipt,
                        requestEqualityEvidenceV1: existing.requestEqualityEvidenceV1,
                        existingContent: existing.content as PrismaJson.SessionMessageContent,
                        candidateContent: content,
                    });
                if (
                    requestEqualityEvidenceV1 !== undefined && !matchedOpaqueEquality
                    || requestEqualityEvidenceV1 === undefined
                        && existingEqualityEvidence !== null
                        && !matchedPlainEquality
                        && !matchedAccountRetryAfterHostEquality
                    || !matchedPlainEquality && !matchedOpaqueEquality && !isDeepStrictEqual(existing.content, content)
                    || existing.messageRole !== null && existing.messageRole !== messageRole
                ) {
                    return identityConflict;
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
                            targetExecutionRunId: true,
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
                    pending: (await projectPendingMessageRows(tx, [pending]))[0]!,
                    pendingCount: session.pendingCount ?? 0,
                    pendingBlockedCount: session.pendingBlockedCount ?? 0,
                    pendingVersion: session.pendingVersion ?? 0,
                    badgeAttentionChanged: false,
                    recipientCursors: [],
                };
            }

            const terminalTranscript = await tx.sessionMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    sidechainId: true,
                    targetExecutionRunId: true,
                    content: true,
                    messageRole: true,
                    deliveryResolution: true,
                    inputAdmissionReceipt: true,
                    authorAccountId: true,
                    requestEqualityEvidenceV1: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });
            if (terminalTranscript) {
                const identityConflict = {
                    ok: false,
                    error: "invalid-params",
                    ...(targetExecutionRunId !== null
                        || terminalTranscript.targetExecutionRunId !== null
                        || terminalTranscript.sidechainId !== null
                        ? { admissionRejectionCode: "session_input_idempotency_conflict" as const }
                        : {}),
                } as const;
                if (terminalTranscript.targetExecutionRunId !== targetExecutionRunId) {
                    return identityConflict;
                }
                const terminalReceipt = terminalTranscript.inputAdmissionReceipt == null
                    ? null
                    : SessionInputAdmissionReceiptV1Schema.safeParse(terminalTranscript.inputAdmissionReceipt);
                const terminalAuthorAccountId = deriveSessionMessageAuthorAccountIdV1({
                    messageRole: terminalTranscript.messageRole,
                    inputAdmissionReceipt: terminalTranscript.inputAdmissionReceipt,
                });
                if (
                    terminalTranscript.authorAccountId != null
                    && terminalTranscript.authorAccountId !== terminalAuthorAccountId
                ) {
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: "session_input_idempotency_conflict",
                    } as const;
                }
                if (
                    terminalReceipt !== null
                    && (!terminalReceipt.success || !isSameSessionInputAdmissionIssuer(terminalReceipt.data, inputAdmissionReceipt))
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
                    return identityConflict;
                }
                const matchedTerminalPlainEquality = expectedPlainEqualityEvidence !== undefined
                    && terminalEqualityEvidence !== null
                    && isDeepStrictEqual(terminalEqualityEvidence.data, expectedPlainEqualityEvidence);
                const matchedTerminalOpaqueEquality = requestEqualityEvidenceV1?.kind === "e2eeTag"
                    && terminalEqualityEvidence !== null
                    && isDeepStrictEqual(terminalEqualityEvidence.data, requestEqualityEvidenceV1);
                const matchedTerminalAccountRetryAfterHostEquality = requestEqualityEvidenceV1 === undefined
                    && isAuthenticatedAccountRetryOfHostVerifiedEncryptedBytes({
                        admission,
                        actorUserId,
                        authorAccountId: terminalTranscript.authorAccountId,
                        inputAdmissionReceipt: terminalTranscript.inputAdmissionReceipt,
                        requestEqualityEvidenceV1: terminalTranscript.requestEqualityEvidenceV1,
                        existingContent: terminalTranscript.content as PrismaJson.SessionMessageContent,
                        candidateContent: content,
                    });
                if (
                    expectedPlainEqualityEvidence !== undefined
                    && terminalEqualityEvidence !== null
                    && !matchedTerminalPlainEquality
                    || requestEqualityEvidenceV1 !== undefined && !matchedTerminalOpaqueEquality
                    || requestEqualityEvidenceV1 === undefined
                        && terminalEqualityEvidence !== null
                        && !matchedTerminalPlainEquality
                        && !matchedTerminalAccountRetryAfterHostEquality
                ) {
                    return identityConflict;
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
                        return identityConflict;
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
                        sidechainId: terminalTranscript.sidechainId,
                        inputAdmissionReceipt: terminalReceipt?.success ? terminalReceipt.data : null,
                        authorAccountId: terminalTranscript.authorAccountId,
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
                    recipientCursors: [],
                } as const;
            }

            const position = await reserveNextPendingQueuePosition(tx, sessionId);

            if (admissionMode === "continuation_if_no_queued_user_input") {
                const queuedUserInput = await tx.sessionPendingMessage.findFirst({
                    where: { sessionId, targetExecutionRunId: null, status: "queued", messageRole: "user" },
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
                        recipientCursors: [],
                    } as const;
                }
            }

            const created = await tx.sessionPendingMessage.create({
                data: {
                    sessionId,
                    localId,
                    targetExecutionRunId,
                    messageRole,
                    content,
                    requestedAction,
                    status: "queued",
                    deliveryState: deliveryMode === "external_handoff" ? "external_handoff" : undefined,
                    position,
                    authorAccountId: deriveSessionMessageAuthorAccountIdV1({ messageRole, inputAdmissionReceipt }),
                    inputAdmissionReceipt,
                    ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
                },
                select: {
                    localId: true,
                    targetExecutionRunId: true,
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

            const activationTarget = targetExecutionRunId === null ? await armPendingActivationAuthorizationInTx({
                tx,
                sessionId,
                requestId: localId,
                currentAccess: access.access,
                ...(params.resumeWhenAvailable === true ? { resumeWhenAvailable: true as const } : {}),
            }) : undefined;
            const { pendingCount, pendingBlockedCount, pendingVersion, recipientCursors, badgeAttentionChanged, meaningfulActivityAt } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null ? 1 : 0,
                meaningfulActivityAt: created.createdAt,
                activationTarget,
            });

            return {
                ok: true,
                didWrite: true,
                pending: (await projectPendingMessageRows(tx, [created]))[0]!,
                pendingCount,
                pendingBlockedCount,
                pendingVersion,
                badgeAttentionChanged,
                recipientCursors,
                meaningfulActivityAt,
                ...(activationTarget ? { activationTarget } : {}),
            };
        });
    } catch (error) {
        if (isTransactionAcquisitionUnavailableError(error)) {
            reportPendingOperationError({
                operation: "enqueue",
                sessionId,
                localId,
                diagnosticCorrelationId: params.diagnosticCorrelationId,
                prismaCode: "P2028",
                error,
            }, "pending delivery transaction acquisition failed");
            return {
                ok: false,
                error: "transaction-unavailable",
                retryAfterMs: 1_000,
                ...(params.diagnosticCorrelationId ? { correlationId: params.diagnosticCorrelationId } : {}),
            };
        }
        reportPendingOperationError({
            operation: "enqueue",
            sessionId,
            localId,
            diagnosticCorrelationId: params.diagnosticCorrelationId,
            error,
        }, "pending delivery operation failed");
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
    targetExecutionRunId?: string | null;
    localId: string;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction: PendingRequestedActionV1;
    requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
    /** Server-verified immutable invocation constraints; never read from encrypted content. */
    callerInputConstraints?: CallerInputConstraintsV1;
}>): Promise<SessionInputAdmissionResultV1> {
    const inputAdmissionReceipt = buildSessionInputAdmissionReceipt({ issuer: "authenticatedMachine",
        callerInputConstraints: params.callerInputConstraints });
    if (inputAdmissionReceipt.issuer !== "authenticatedMachine") {
        throw new Error("Machine admission receipt parsed to the wrong issuer arm");
    }
    const result = await enqueuePendingMessageWithAdmission({
        actorUserId: params.accountId,
        sessionId: params.sessionId,
        targetExecutionRunId: params.targetExecutionRunId,
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
        if (result.didWrite) {
            await emitPendingChanged({
                sessionId: params.sessionId,
                changedByAccountId: params.accountId,
                pendingCount: result.pendingCount,
                pendingBlockedCount: result.pendingBlockedCount,
                pendingVersion: result.pendingVersion,
                meaningfulActivityAt: result.meaningfulActivityAt,
                recipientCursors: result.recipientCursors,
                ...(params.targetExecutionRunId
                    ? { recipient: { kind: "execution_run" as const, runId: params.targetExecutionRunId } }
                    : {}),
                ...(result.activationTarget ? { activationTarget: result.activationTarget } : {}),
            });
        }
        return {
            status: result.didWrite ? "accepted" : "alreadyAccepted",
            localId: params.localId,
        };
    }
    if (result.error === "internal" || result.error === "transaction-unavailable") {
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
        recipientCursorsPending: RecipientCursor[];
        recipientCursorsMessage: RecipientCursor[];
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
    inputAdmissionReceipt: SessionInputAdmissionReceiptV1;
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
    const request = readSessionInputRequest(requestMeta);
    const authority = readSessionInputAuthority(finalMeta);
    if (!request || !authority || request.v !== authority.v) return false;
    let expectedMeta: Record<string, unknown>;
    try {
        const expectedAuthority = request.v === 1
            ? settleSessionInputRequestV1({
                request,
                currentSessionPermissionCeiling: authority.permission.admittedPermissionCeiling,
                inputAdmissionReceipt: params.inputAdmissionReceipt,
            })
            : settleSessionInputRequestV2({
                request,
                currentSessionPermissionCeiling: authority.permission.admittedPermissionCeiling,
                inputAdmissionReceipt: params.inputAdmissionReceipt,
            });
        const expectedProvenance = request.v === 1
            ? settleSessionMessageProvenanceV1({
                request,
                requestedProvenance: requestMeta?.[SESSION_MESSAGE_PROVENANCE_META_KEY],
                inputAdmissionReceipt: params.inputAdmissionReceipt,
            })
            : settleSessionMessageProvenanceV2({
                request,
                requestedProvenance: requestMeta?.[SESSION_MESSAGE_PROVENANCE_META_KEY],
                inputAdmissionReceipt: params.inputAdmissionReceipt,
            });
        expectedMeta = {
            ...withSessionInputAuthority(requestMeta ?? {}, expectedAuthority),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: expectedProvenance,
        };
    } catch {
        return false;
    }
    const expected = {
        ...(params.requestContent.v as Record<string, unknown>),
        meta: expectedMeta,
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

type QueuedPendingInputForRejection = Readonly<{
    targetExecutionRunId?: string | null;
    status: string;
    deliveryState: string | null;
    content: unknown;
    requestedAction: unknown;
    requestEqualityEvidenceV1: unknown;
}>;

async function rejectQueuedPendingInputInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    localId: string;
    existing: QueuedPendingInputForRejection;
    code: SessionInputAdmissionRejectionCodeV1;
}>) {
    if (params.existing.status !== "queued") return null;
    const requestContent = params.existing.content as PrismaJson.SessionPendingMessageContent;
    const requestedAction = PendingRequestedActionV1Schema.safeParse(params.existing.requestedAction);
    if (!requestedAction.success) return null;

    let requestEqualityEvidenceV1: SessionInputRequestEqualityEvidenceV1;
    if (requestContent.t === "plain") {
        const derived = derivePlainRequestEqualityEvidence({
            content: requestContent,
            requestedAction: requestedAction.data,
        });
        if (!derived) return null;
        requestEqualityEvidenceV1 = derived;
    } else {
        const parsed = SessionInputRequestEqualityEvidenceV1Schema.safeParse(
            params.existing.requestEqualityEvidenceV1,
        );
        if (!parsed.success || parsed.data.kind !== "e2eeTag") return null;
        requestEqualityEvidenceV1 = parsed.data;
    }

    const discardedFields = pendingDeliveryStatusV1ToPersistedFields({
        status: "discarded",
        reason: params.code,
    });
    await params.tx.sessionPendingMessage.update({
        where: {
            sessionId_localId: {
                sessionId: params.sessionId,
                localId: params.localId,
            },
        },
        data: {
            ...discardedFields,
            discardedAt: new Date(),
            requestEqualityEvidenceV1,
        },
    });
    await reconcilePendingActivationAuthorizationForRemovedRequestInTx({
        tx: params.tx,
        sessionId: params.sessionId,
        requestId: params.localId,
    });
    return applyPendingSessionStateChange({
        tx: params.tx,
        sessionId: params.sessionId,
        pendingCountDelta: params.existing.targetExecutionRunId == null ? -1 : 0,
        pendingBlockedCountDelta: params.existing.targetExecutionRunId == null && params.existing.deliveryState === "blocked" ? -1 : 0,
    });
}

/** Retires the exact deterministic queued Session input owned by one Automation Run. */
export async function retireAutomationPendingInputInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sessionId: string;
    runId: string;
}>): Promise<boolean> {
    const localId = `automation:run:${params.runId}`;
    const existing = await params.tx.sessionPendingMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId } },
        select: {
            status: true,
            deliveryState: true,
            content: true,
            requestedAction: true,
            requestEqualityEvidenceV1: true,
        },
    });
    if (!existing || existing.status !== "queued") return false;
    const state = await rejectQueuedPendingInputInTx({
        tx: params.tx,
        sessionId: params.sessionId,
        localId,
        existing,
        code: "session_input_cancelled",
    });
    if (!state) throw new Error("Automation pending input could not be retired");
    afterTx(params.tx, () => {
        void emitPendingChanged({
            sessionId: params.sessionId,
            changedByAccountId: params.accountId,
            pendingCount: state.pendingCount,
            pendingBlockedCount: state.pendingBlockedCount,
            pendingVersion: state.pendingVersion,
            recipientCursors: state.recipientCursors,
        }).catch((error) => {
            warn(
                {
                    module: "session-pending-service",
                    operation: "automation-input-cancellation",
                    sessionId: params.sessionId,
                    localId,
                    err: error,
                },
                "failed to publish Automation pending input cancellation",
            );
        });
    });
    return true;
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
            requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
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
                    targetExecutionRunId: true,
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
                    select: { id: true, seq: true, localId: true, sidechainId: true, messageRole: true, content: true, inputAdmissionReceipt: true, authorAccountId: true, deliveryResolution: true, createdAt: true, updatedAt: true },
                });
                const state = await readCurrentPendingMutationState(tx, sessionId);
                if (!committed) return { ok: false, error: "not-found" } as const;
                return {
                    ok: true,
                    result: { status: "alreadyAccepted", localId },
                    ...state,
                    recipientCursorsPending: state.recipientCursors,
                    recipientCursorsMessage: [],
                    message: {
                        ...committed,
                        localId: committed.localId ?? localId,
                        messageRole: parseSessionMessageRole(committed.messageRole),
                        content: committed.content as PrismaJson.SessionMessageContent,
                        inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.safeParse(committed.inputAdmissionReceipt).data ?? null,
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
                    recipientCursorsPending: state.recipientCursors,
                    recipientCursorsMessage: [],
                } as const;
            }
            if (existing.deliveryState !== "delivering") return { ok: false, error: "conflict" } as const;
            if (existing.targetExecutionRunId !== null && !supportsMachineSessionInputAdmissionProtocolVersion(targetMachine.operationProtocolCapabilities, 2)) {
                return { ok: false, error: "forbidden" } as const;
            }
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
                const state = await rejectQueuedPendingInputInTx({
                    tx,
                    sessionId,
                    localId,
                    existing,
                    code: decision.code,
                });
                if (!state) return { ok: false, error: "conflict" } as const;
                return {
                    ok: true,
                    result: { status: "rejected", code: decision.code },
                    ...state,
                    recipientCursorsPending: state.recipientCursors,
                    recipientCursorsMessage: [],
                } as const;
            }

            const finalContent = decision.finalContent as PrismaJson.SessionMessageContent;
            const publisherEquality = decision.requestEqualityEvidenceV1 === undefined
                ? undefined
                : SessionInputRequestEqualityEvidenceV1Schema.safeParse(decision.requestEqualityEvidenceV1);
            if (publisherEquality !== undefined && (
                !publisherEquality.success
                || publisherEquality.data.kind !== "e2eeTag"
                || finalContent.t !== "encrypted"
                || existing.targetExecutionRunId === null
            )) return { ok: false, error: "conflict" } as const;
            if (existing.targetExecutionRunId !== null && requestContent.t === "encrypted" && !publisherEquality?.success) {
                return { ok: false, error: "conflict" } as const;
            }
            if (publisherEquality?.success && existing.requestEqualityEvidenceV1 != null
                && !isDeepStrictEqual(publisherEquality.data, existing.requestEqualityEvidenceV1)) {
                return { ok: false, error: "conflict" } as const;
            }
            if (existing.targetExecutionRunId !== null && existing.requestEqualityEvidenceV1 != null
                && isDeepStrictEqual(requestContent, finalContent)) {
                const evidence = SessionInputRequestEqualityEvidenceV1Schema.safeParse(existing.requestEqualityEvidenceV1);
                if (!evidence.success || (requestContent.t === "plain" && !readSessionInputAuthority(readPlainMessageMeta(requestContent)))) {
                    return { ok: false, error: "conflict" } as const;
                }
                const state = await readCurrentPendingMutationState(tx, sessionId);
                return { ok: true, result: { status: "alreadyAccepted", localId }, ...state, recipientCursorsPending: [], recipientCursorsMessage: [] } as const;
            }
            if (
                requestContent.t !== finalContent.t
                || requestContent.t === "plain"
                    && !isExactPlainRequestToAuthorityReplacement({
                        requestContent,
                        finalContent,
                        inputAdmissionReceipt: receipt.data,
                    })
            ) return { ok: false, error: "conflict" } as const;
            if (existing.targetExecutionRunId !== null) {
                const recipient = finalContent.t === "plain" ? readParticipantRecipientRoutingIdentityV1(readPlainMessageMeta(finalContent)) : null;
                if (finalContent.t === "plain" && (recipient?.kind !== "execution_run" || recipient.runId !== existing.targetExecutionRunId)) {
                    return { ok: false, error: "conflict" } as const;
                }
                const equality = requestContent.t === "plain"
                    ? derivePlainRequestEqualityEvidence({ content: requestContent, requestedAction: requestedAction.data })
                    : publisherEquality?.data;
                if (!equality) return { ok: false, error: "conflict" } as const;
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId: existing.targetExecutionRunId, deliveryState: "delivering" },
                    data: { content: finalContent, requestEqualityEvidenceV1: equality },
                });
                const state = await applyPendingSessionStateChange({ tx, sessionId });
                return { ok: true, result: { status: "accepted", localId }, ...state, recipientCursorsPending: state.recipientCursors, recipientCursorsMessage: [] } as const;
            }
            const policy = readEncryptionFeatureEnv(process.env);
            const sessionEncryptionMode = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const committed = await createSessionMessageFromPending(tx, {
                sessionId,
                sessionEncryptionMode,
                storagePolicy: policy.storagePolicy,
                localId,
                targetExecutionRunId: existing.targetExecutionRunId,
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
            await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
            const state = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: -1,
                meaningfulActivityAt: committed.didWrite ? committed.message.createdAt : undefined,
            });
            const recipientCursorsMessage = committed.didWrite || committed.didUpdate
                ? await markSessionProjectionRecipientsChanged({
                    tx,
                    sessionId,
                    hint: { lastMessageSeq: committed.message.seq, lastMessageId: committed.message.id },
                })
                : [];
            return {
                ok: true,
                result: { status: "accepted", localId },
                ...state,
                recipientCursorsPending: state.recipientCursors,
                recipientCursorsMessage,
                message: committed.message,
                ...(readyProjection ? { readyProjection } : {}),
            } as const;
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdatePendingMessageResult =
    | { ok: true; localId: string; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "local-id-conflict" | "pending-mutation-conflict" | "delivery-settlement-conflict" | "internal"; code?: EncryptionPolicyRejectionCode };

export type UpdatePendingRequestedActionResult =
    | {
        ok: true;
        didUpdate: boolean;
        requestedAction: PendingRequestedActionV1;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursors: RecipientCursor[];
        activationTarget?: PendingActivationTarget;
      }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "action-conflict" | "internal" };

export async function updatePendingRequestedAction(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    requestedAction: PendingRequestedActionV1;
    resumeWhenAvailable?: boolean;
    authentication: SessionAccessAuthentication;
}>): Promise<UpdatePendingRequestedActionResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    if (targetExecutionRunId !== null && params.resumeWhenAvailable !== undefined) {
        return { ok: false, error: "invalid-params" };
    }
    const localId = readPendingLocalId(params.localId) ?? "";
    const requestedActionResult = PendingRequestedActionV1Schema.safeParse(params.requestedAction);
    if (!actorUserId || !sessionId || !localId || !requestedActionResult.success) {
        return { ok: false, error: "invalid-params" };
    }
    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        // Freeze the request's observed revision before transaction acquisition. `inTx` may
        // replay its callback after a serialization/SQLite conflict; rereading inside that
        // callback would silently reinterpret a stale writer as a fresh/idempotent writer.
        const existing = await db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
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
            targetExecutionRunId,
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
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            if (!canReplaceBlocked && existing.providerAction === null && isDeepStrictEqual(currentAction, requestedActionResult.data)) {
                const retained = await tx.sessionPendingMessage.count({ where: frozenWhere });
                if (retained !== 1) {
                    return { ok: false, error: "action-conflict" } as const;
                }
                const shouldArmActivation = targetExecutionRunId === null && shouldArmPendingActivationAuthorization({
                    requestedAction: requestedActionResult.data,
                    resumeWhenAvailable: params.resumeWhenAvailable,
                });
                if (shouldArmActivation || targetExecutionRunId === null && params.resumeWhenAvailable === false) {
                    await reconcileSessionPendingQueueStateInTx(tx, sessionId);
                    const activationTarget = shouldArmActivation
                        ? await armPendingActivationAuthorizationInTx({
                            tx,
                            sessionId,
                            requestId: localId,
                            currentAccess: access.access,
                            ...(params.resumeWhenAvailable === true ? { resumeWhenAvailable: true as const } : {}),
                        })
                        : undefined;
                    if (!shouldArmActivation) {
                        await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
                    }
                    const state = await applyPendingSessionStateChange({ tx, sessionId, activationTarget });
                    return {
                        ok: true,
                        didUpdate: true,
                        requestedAction: currentAction,
                        ...(activationTarget ? { activationTarget } : {}),
                        ...state,
                    } as const;
                }
                const session = await reconcileSessionPendingQueueStateInTx(tx, sessionId);
                const recipientCursors = session.didRepair
                    ? await markPendingStateChangedRecipients({
                        tx,
                        sessionId,
                        pendingCount: session.pendingCount,
                        pendingBlockedCount: session.pendingBlockedCount,
                        pendingVersion: session.pendingVersion,
                    })
                    : [];
                return {
                    ok: true,
                    didUpdate: false,
                    requestedAction: currentAction,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                    recipientCursors,
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
            const shouldArmActivation = targetExecutionRunId === null && shouldArmPendingActivationAuthorization({
                requestedAction: requestedActionResult.data,
                resumeWhenAvailable: params.resumeWhenAvailable,
            });
            const activationTarget = shouldArmActivation
                ? await armPendingActivationAuthorizationInTx({
                    tx,
                    sessionId,
                    requestId: localId,
                    currentAccess: access.access,
                    ...(params.resumeWhenAvailable === true ? { resumeWhenAvailable: true as const } : {}),
                })
                : undefined;
            if (targetExecutionRunId === null && !shouldArmActivation) {
                await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
            }
            const pendingCount = await tx.sessionPendingMessage.count({ where: { sessionId, targetExecutionRunId: null, status: "queued" } });
            const pendingBlockedCount = await tx.sessionPendingMessage.count({
                where: { sessionId, targetExecutionRunId: null, status: "queued", deliveryState: "blocked" },
            });
            const session = await tx.session.update({
                where: { id: sessionId },
                data: { pendingCount, pendingBlockedCount, pendingVersion: { increment: 1 } },
                select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });
            const recipientCursors = await markPendingStateChangedRecipients({
                tx,
                sessionId,
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
                pendingVersion: session.pendingVersion,
                activationTarget,
            });
            return {
                ok: true,
                didUpdate: true,
                requestedAction: requestedActionResult.data,
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
                pendingVersion: session.pendingVersion,
                recipientCursors,
                ...(activationTarget ? { activationTarget } : {}),
            } as const;
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function updatePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
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
    authentication: SessionAccessAuthentication;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
)): Promise<UpdatePendingMessageResult> {
    const directTokenInput = params.authentication.apiTokenGrant !== undefined;
    if (directTokenInput && params.messageRole !== undefined && params.messageRole !== null && params.messageRole !== "user") {
        return { ok: false, error: "invalid-params" };
    }
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
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
    if (targetExecutionRunId !== null && content.t === "plain") {
        const recipient = readParticipantRecipientRoutingIdentityV1(readPlainMessageMeta(content));
        if (recipient?.kind !== "execution_run" || recipient.runId !== targetExecutionRunId) {
            return { ok: false, error: "invalid-params" };
        }
    }

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inTx(async (tx) => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
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
                suppliedRole: directTokenInput ? (content.t === "encrypted" ? "user" : undefined) : params.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-message",
                },
            }).messageRole;
            if (directTokenInput && messageRole !== "user") return { ok: false, error: "invalid-params" } as const;
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
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                select: {
                    id: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    providerAction: true,
                },
            });
            if (!existing) {
                if (!replacementLocalId || replacementMutationFingerprintValue === null) {
                    return { ok: false, error: "not-found" } as const;
                }
                const replayed = await tx.sessionPendingMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId: replacementLocalId }, targetExecutionRunId },
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
                    recipientCursors: [],
                    badgeAttentionChanged: false,
                } as const;
            }
            if (isOrdinaryPendingMutationFenced(existing)) {
                // Exact provider custody (a real claim with providerAction) has
                // consumed the editable draft: the ordinary editor sees the
                // same absence the in-flight message has, and only the
                // delivery settlement owners may still mutate the row. Rows
                // that are provider-effect-possible without an exact claim
                // keep the explicit settlement fence.
                if (existing.deliveryState === "delivering" && existing.providerAction !== null) {
                    return { ok: false, error: "not-found" } as const;
                }
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
                    requestEqualityEvidenceV1: getActivePrismaRuntime().DbNull,
                    inputAdmissionReceipt: buildSessionInputAdmissionReceipt({ issuer: "authenticatedAccount", access: access.access,
                        callerInputConstraints: params.authentication.callerInputConstraints ?? params.authentication.apiTokenGrant }),
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
            if (replacementLocalId) {
                await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
            }

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return {
                ok: true,
                localId: replacementLocalId ?? localId,
                pendingVersion,
                pendingCount,
                pendingBlockedCount,
                recipientCursors,
                badgeAttentionChanged,
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DeletePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "delivery-settlement-conflict" | "internal" };

export async function deletePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    authentication: SessionAccessAuthentication;
}): Promise<DeletePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inTx(async (tx) => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
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
                    recipientCursors: [],
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
            await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null && existing.status === "queued" ? -1 : 0,
                pendingBlockedCountDelta: targetExecutionRunId === null && existing.status === "queued" && existing.deliveryState === "blocked" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type MarkPendingActivationFailedResult =
    | { ok: true; didFail: boolean; pendingCount: number; pendingBlockedCount: number; pendingVersion: number; recipientCursors: RecipientCursor[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

/** Marks only the exact current waiting activation terminal-failed; stale reports are no-ops. */
export async function markPendingActivationFailed(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    requestId: string;
    requestedAt: number;
    failureCode: PendingActivationFailureCodeV1;
}>): Promise<MarkPendingActivationFailedResult> {
    if (
        !params.actorUserId
        || !params.sessionId
        || !params.requestId
        || !Number.isSafeInteger(params.requestedAt)
        || params.requestedAt < 0
    ) return { ok: false, error: "invalid-params" };
    const access = await resolveStructuralSessionAccess(db, { accountId: params.actorUserId, sessionId: params.sessionId });
    if (!access) return { ok: false, error: "session-not-found" };
    if (access.level !== "owner") return { ok: false, error: "forbidden" };
    try {
        return await inTx(async (tx) => {
            const authority = await assertSessionOwnerInTx({ tx, accountId: params.actorUserId, sessionId: params.sessionId });
            if (!authority.ok) return { ok: false, error: "session-not-found" } as const;
            const didFail = await markPendingActivationAuthorizationFailedInTx({
                tx,
                sessionId: params.sessionId,
                requestId: params.requestId,
                requestedAt: new Date(params.requestedAt),
                failureCode: params.failureCode,
            });
            const session = await tx.session.findUniqueOrThrow({
                where: { id: params.sessionId },
                select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });
            const recipientCursors = didFail
                ? await markPendingStateChangedRecipients({
                    tx,
                    sessionId: params.sessionId,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                })
                : [];
            return { ok: true, didFail, ...session, recipientCursors } as const;
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

type PendingMutationState = {
    pendingVersion: number;
    pendingCount: number;
    pendingBlockedCount: number;
    recipientCursors: RecipientCursor[];
    badgeAttentionChanged: boolean;
};

type TargetPendingState = Pick<PendingMutationState, "pendingCount" | "pendingBlockedCount" | "pendingVersion">;

/** Target ACK counts are separate from the main Session projection published after commit. */
async function withTargetPendingStateInTx<T extends { ok: boolean; pendingVersion?: number }>(
    tx: Tx,
    sessionId: string,
    targetExecutionRunId: string | null,
    result: T,
): Promise<T & { targetPendingState?: TargetPendingState }> {
    if (!result.ok || targetExecutionRunId === null || result.pendingVersion === undefined) return result;
    const [pendingCount, pendingBlockedCount] = await Promise.all([
        tx.sessionPendingMessage.count({ where: { sessionId, targetExecutionRunId, status: "queued" } }),
        tx.sessionPendingMessage.count({ where: { sessionId, targetExecutionRunId, status: "queued", deliveryState: "blocked" } }),
    ]);
    return { ...result, targetPendingState: { pendingCount, pendingBlockedCount, pendingVersion: result.pendingVersion } };
}

async function readCurrentPendingMutationState(tx: Tx, sessionId: string): Promise<PendingMutationState> {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
    });
    return {
        pendingVersion: session?.pendingVersion ?? 0,
        pendingCount: session?.pendingCount ?? 0,
        pendingBlockedCount: session?.pendingBlockedCount ?? 0,
        recipientCursors: [],
        badgeAttentionChanged: false,
    };
}

export type ResolveAcceptedPendingDeliveryResult =
    | {
        ok: true;
        targetPendingState?: TargetPendingState;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursors: RecipientCursor[];
        recipientCursorsPending?: RecipientCursor[];
        recipientCursorsMessage?: RecipientCursor[];
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
        recipientCursors?: RecipientCursor[];
        badgeAttentionChanged?: boolean;
      }
    | { ok: false; error: "transaction-unavailable"; retryAfterMs: number; correlationId?: string };

type PendingDeliveryResolutionInput = Readonly<{
    targetExecutionRunId?: string | null;
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
        expectedSidechainId?: string | null;
        target: Extract<PendingDeliveryStatusTransitionTargetV1, { status: "resolved" }>;
    }>,
): Promise<
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursors: RecipientCursor[];
        recipientCursorsPending: RecipientCursor[];
        recipientCursorsMessage: RecipientCursor[];
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
        recipientCursors: RecipientCursor[];
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
        expectedSidechainId: params.expectedSidechainId ?? null,
        targetExecutionRunId: params.existing.targetExecutionRunId,
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
        await reconcilePendingActivationAuthorizationForRemovedRequestInTx({
            tx,
            sessionId: params.sessionId,
            requestId: params.localId,
        });
        const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
            tx,
            sessionId: params.sessionId,
            pendingBlockedCountDelta: params.existing.targetExecutionRunId == null ? blocked.pendingBlockedCountDelta : 0,
        });
        return {
            ok: false,
            error: committed.error,
            pendingStateChanged: true,
            pendingVersion,
            pendingCount,
            pendingBlockedCount,
            recipientCursors,
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
    await reconcilePendingActivationAuthorizationForRemovedRequestInTx({
        tx,
        sessionId: params.sessionId,
        requestId: params.localId,
    });

    const previousDeliveryStatus = readPendingDeliveryStatus(params.existing);
    const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
        tx,
        sessionId: params.sessionId,
        pendingCountDelta: params.existing.targetExecutionRunId != null || previousDeliveryStatus.status === "discarded" ? 0 : -1,
        pendingBlockedCountDelta: params.existing.targetExecutionRunId == null && previousDeliveryStatus.status === "blocked" ? -1 : 0,
        meaningfulActivityAt: committed.didWrite ? committed.message.createdAt : undefined,
    });
    const recipientCursorsMessage = committed.didWrite || committed.didUpdate
        ? await markSessionProjectionRecipientsChanged({
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
        recipientCursors,
        recipientCursorsPending: recipientCursors,
        recipientCursorsMessage,
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
    targetExecutionRunId?: string | null;
    expectedSidechainId?: string | null;
    localId: string;
    publisherAuthority: CurrentSessionPublisherAuthority;
    diagnosticCorrelationId?: string;
}): Promise<ResolveAcceptedPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const sidechain = params.expectedSidechainId == null ? null : SidechainIdSchema.safeParse(params.expectedSidechainId);
    if (sidechain !== null && !sidechain.success) return { ok: false, error: "invalid-params" };
    const expectedSidechainId = sidechain?.data ?? null;
    if ((targetExecutionRunId === null) !== (expectedSidechainId === null)) return { ok: false, error: "invalid-params" };
    const localId = readPendingLocalId(params.localId) ?? "";
    if (!actorUserId || !sessionId || !localId) {
        return { ok: false, error: "invalid-params" };
    }

    const access = await resolveStructuralSessionAccess(db, { accountId: actorUserId, sessionId: sessionId });
    if (!access) return { ok: false, error: "session-not-found" };
    if (access.level !== "owner") return { ok: false, error: "forbidden" };

    try {
        return await rejoinPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const result: ResolveAcceptedPendingDeliveryResult = await (async () => {
                const access = await assertSessionOwnerInTx({ tx, accountId: actorUserId, sessionId });
                if (!access.ok) return { ok: false, error: "session-not-found" } as const;
                if (!await hasExactCurrentPublisherAuthorityInTx(
                    tx,
                    params.publisherAuthority,
                    actorUserId,
                    sessionId,
                )) {
                    return { ok: false, error: "forbidden" } as const;
                }
                if (targetExecutionRunId !== null && !await hasCurrentPublisherTargetAdmissionCapabilityInTx(tx, params.publisherAuthority)) {
                    return { ok: false, error: "forbidden" } as const;
                }
                const existing = await tx.sessionPendingMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                    select: {
                        targetExecutionRunId: true,
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
                            sidechainId: expectedSidechainId,
                            OR: [
                                { messageRole: "user" },
                                { messageRole: null },
                            ],
                        },
                        select: { id: true, seq: true, localId: true, sidechainId: true, targetExecutionRunId: true, messageRole: true, content: true, inputAdmissionReceipt: true, authorAccountId: true, deliveryResolution: true, createdAt: true, updatedAt: true },
                    });
                    if (!committed) {
                        return { ok: false, error: "not-found" } as const;
                    }
                    if (committed.targetExecutionRunId !== targetExecutionRunId) {
                        return { ok: false, error: "transcript-conflict" } as const;
                    }
                    if (targetExecutionRunId !== null) {
                        const content = committed.content as PrismaJson.SessionMessageContent;
                        const recipient = readParticipantRecipientRoutingIdentityV1(readPlainMessageMeta(content));
                        if (content.t === "plain" && (recipient?.kind !== "execution_run" || recipient.runId !== targetExecutionRunId)) {
                            return { ok: false, error: "transcript-conflict" } as const;
                        }
                    }

                    return {
                        ok: true,
                        ...(await readCurrentPendingMutationState(tx, sessionId)),
                        didResolve: false,
                        message: {
                            id: committed.id,
                            seq: committed.seq,
                            localId: committed.localId ?? localId,
                            sidechainId: committed.sidechainId,
                            inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.safeParse(committed.inputAdmissionReceipt).data ?? null,
                            authorAccountId: committed.authorAccountId,
                            messageRole: parseSessionMessageRole(committed.messageRole),
                            content: committed.content as PrismaJson.SessionMessageContent,
                            deliveryResolution: parseSessionMessageDeliveryResolutionV1(committed.deliveryResolution),
                            createdAt: committed.createdAt,
                            updatedAt: committed.updatedAt,
                        },
                    } as const;
                }

                if (targetExecutionRunId !== null) {
                    if (existing.status !== "queued" || existing.deliveryState !== "delivering") {
                        return { ok: false, error: "not-materialized" } as const;
                    }
                    const content = existing.content as PrismaJson.SessionPendingMessageContent;
                    const recipient = readParticipantRecipientRoutingIdentityV1(readPlainMessageMeta(content));
                    if (content.t === "plain" && (
                        recipient?.kind !== "execution_run"
                        || recipient.runId !== targetExecutionRunId
                        || readSessionInputRequest(readPlainMessageMeta(content)) !== null
                    )) return { ok: false, error: "transcript-conflict" } as const;
                }
                if (!canTransitionPendingDeliveryStatus(existing, { status: "resolved", reason: "provider_accepted" })) {
                    return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didResolve: false };
                }

                const requestedAction = PendingRequestedActionV1Schema.safeParse(existing.requestedAction);
                const isExactAction = requestedAction.success && requestedAction.data.kind !== "enqueue";
                const earlierUnresolved = isExactAction ? null : await tx.sessionPendingMessage.findFirst({
                    where: {
                        sessionId,
                        targetExecutionRunId,
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
                    expectedSidechainId,
                    target: { status: "resolved", reason: "provider_accepted" },
                });
                if (!resolved.ok) return resolved;
                return { ...resolved, didResolve: true };
            })();
            return await withTargetPendingStateInTx(tx, sessionId, targetExecutionRunId, result);
        }));
    } catch (error) {
        if (isTransactionAcquisitionUnavailableError(error)) {
            reportPendingOperationError({
                operation: "provider-acceptance",
                sessionId,
                localId,
                diagnosticCorrelationId: params.diagnosticCorrelationId,
                prismaCode: "P2028",
                error,
            }, "pending delivery transaction acquisition failed");
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
    | { ok: true; targetPendingState?: TargetPendingState; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; didUpdate: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function blockPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    authentication?: SessionAccessAuthentication;
    targetExecutionRunId?: string | null;
    publisherAuthority?: CurrentSessionPublisherAuthority;
    localId: string;
    reason: PendingDeliveryBlockedReason;
}): Promise<BlockPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";
    const reason = normalizePendingDeliveryBlockedReason(params.reason);

    if (!actorUserId || !sessionId || !localId || !reason) return { ok: false, error: "invalid-params" };

    if (params.authentication) {
        const decision = await resolveSessionAccessForOperation(db, {
            accountId: actorUserId,
            sessionId,
            authentication: params.authentication,
            capability: "editSessionRecords",
        });
        if (decision.status !== "allowed") return { ok: false, error: "session-not-found" };
    } else {
        const access = await resolveStructuralSessionAccess(db, { accountId: actorUserId, sessionId });
        if (!access) return { ok: false, error: "session-not-found" };
        if (access.level !== "owner") return { ok: false, error: "forbidden" };
    }

    try {
        return await inTx(async (tx) => {
            const result: BlockPendingDeliveryResult = await (async () => {
                const access = params.authentication
                    ? await assertSessionCapabilityInTx({
                        tx,
                        accountId: actorUserId,
                        sessionId,
                        capability: "editSessionRecords",
                        authentication: params.authentication,
                    })
                    : await assertSessionOwnerInTx({ tx, accountId: actorUserId, sessionId });
                if (!access.ok) return { ok: false, error: "session-not-found" } as const;
                if (targetExecutionRunId !== null && (
                    !params.publisherAuthority
                    || !await hasExactCurrentPublisherAuthorityInTx(tx, params.publisherAuthority, actorUserId, sessionId)
                    || !await hasCurrentPublisherTargetAdmissionCapabilityInTx(tx, params.publisherAuthority)
                )) return { ok: false, error: "forbidden" } as const;
                if (targetExecutionRunId === null && reason === "session_input_target_unavailable") {
                    return { ok: false, error: "invalid-params" } as const;
                }
                const existing = await tx.sessionPendingMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
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
                    await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
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
                await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });

                const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                    tx,
                    sessionId,
                    pendingBlockedCountDelta: targetExecutionRunId !== null || readPendingDeliveryStatus(existing).status === "blocked" ? 0 : 1,
                });
                return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged, didUpdate: true };
            })();
            return await withTargetPendingStateInTx(tx, sessionId, targetExecutionRunId, result);
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
        recipientCursors: RecipientCursor[];
        badgeAttentionChanged: boolean;
        didWrite: boolean;
        newLocalId: string;
      }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "identity-conflict" | "internal" };

function derivePendingSendAsNewLocalId(sessionId: string, localId: string): string {
    const digest = createHash("sha256")
        .update(`happier.pending.send-as-new.v1\0${sessionId}\0${localId}`, "utf8")
        .digest("hex");
    return `send-as-new-${digest}`;
}

export async function sendPendingDeliveryAsNew(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    authentication: SessionAccessAuthentication;
}): Promise<SendPendingDeliveryAsNewResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) {
        return { ok: false, error: "invalid-params" };
    }
    const newLocalId = derivePendingSendAsNewLocalId(sessionId, localId);

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inTx(async (tx) => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
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
                select: { targetExecutionRunId: true, status: true, deliveryState: true, messageRole: true, content: true, requestedAction: true },
            });
            const replacementAction = { v: 1, kind: "enqueue" } as const;
            if (existingStatus.status === "discarded" && existingStatus.reason === "resent_as_new") {
                if (
                    replacement
                    && replacement.targetExecutionRunId === targetExecutionRunId
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
            await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
            await tx.sessionPendingMessage.create({
                data: {
                    sessionId,
                    localId: newLocalId,
                    targetExecutionRunId,
                    messageRole: existing.messageRole,
                    content: existing.content,
                    requestedAction: replacementAction,
                    status: "queued",
                    position,
                    authorAccountId: existing.authorAccountId,
                    ...(existing.inputAdmissionReceipt == null
                        ? {}
                        : { inputAdmissionReceipt: existing.inputAdmissionReceipt }),
                },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingBlockedCountDelta: targetExecutionRunId === null ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged, didWrite: true, newLocalId };
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
        recipientCursors: RecipientCursor[];
        recipientCursorsPending?: RecipientCursor[];
        recipientCursorsMessage?: RecipientCursor[];
        badgeAttentionChanged: boolean;
        didResolve: boolean;
        didWrite?: boolean;
        didUpdate?: boolean;
        message?: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: false;
        error: PendingSessionAccessError | "forbidden" | "invalid-params" | "transcript-conflict" | "internal";
        pendingStateChanged?: boolean;
        pendingVersion?: number;
        pendingCount?: number;
        pendingBlockedCount?: number;
        recipientCursors?: RecipientCursor[];
        badgeAttentionChanged?: boolean;
      };

export async function markPendingDeliveryHandled(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    authentication: SessionAccessAuthentication;
}): Promise<MarkPendingDeliveryHandledResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await rejoinPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId: null },
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
    | { ok: true; didDismiss: boolean; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function dismissPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    now?: Date;
    authentication: SessionAccessAuthentication;
}): Promise<DismissPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";
    const now = params.now instanceof Date ? params.now : new Date();
    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await rejoinPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
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
            await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
            const state = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null ? -1 : 0,
                pendingBlockedCountDelta: targetExecutionRunId === null && status.status === "blocked" ? -1 : 0,
            });
            return { ok: true, didDismiss: true, ...state } as const;
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DiscardPendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function discardPendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    reason?: string;
    now?: Date;
    authentication: SessionAccessAuthentication;
}): Promise<DiscardPendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";
    const reason = typeof params.reason === "string" ? params.reason : null;
    const now = params.now instanceof Date ? params.now : new Date();

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };
    if (isPendingDeliveryArchivedUncertaintyReasonV1(reason)) {
        return { ok: false, error: "delivery-settlement-conflict" };
    }

    try {
        return await inTx(async (tx) => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            // Explicit discard is a durable user cancellation, so the delivery
            // status transition protocol owns the decision below: delivering
            // and external-handoff custody may be discarded, while archived
            // uncertainty identities stay reserved by the reason guard above.
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
                    recipientCursors: [],
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
            await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null ? -1 : 0,
                pendingBlockedCountDelta: targetExecutionRunId === null && readPendingDeliveryStatus(existing).status === "blocked" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type RestorePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function restorePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    authentication: SessionAccessAuthentication;
}): Promise<RestorePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inTx(async (tx) => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
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

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null && existing.status === "discarded" ? 1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ReorderPendingMessagesResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "internal" };

export async function reorderPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    orderedLocalIds: string[];
    authentication: SessionAccessAuthentication;
}): Promise<ReorderPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const orderedLocalIds = Array.isArray(params.orderedLocalIds) ? params.orderedLocalIds.filter(isPendingLocalId) : [];

    if (!actorUserId || !sessionId || orderedLocalIds.length === 0) return { ok: false, error: "invalid-params" };
    if (new Set(orderedLocalIds).size !== orderedLocalIds.length) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inTx(async (tx) => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const queued = await tx.sessionPendingMessage.findMany({
                where: { sessionId, targetExecutionRunId, status: "queued" },
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
                    // A provider-effect-possible row keeps its queue slot, so
                    // an ordering that would move it is invalid for the
                    // current queue rather than a settlement conflict.
                    return { ok: false, error: "invalid-params" } as const;
                }
            }

            for (const [index, localId] of orderedLocalIds.entries()) {
                const position = queued[index].position;
                const row = queuedByLocalId.get(localId);
                if (
                    (row && isOrdinaryPendingMutationFenced({ status: "queued", ...row }))
                    || row?.position === position
                ) {
                    continue;
                }
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: { position },
                });
            }

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged };
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
