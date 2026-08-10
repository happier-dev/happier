import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import { mapPendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";
import {
    resolveSessionPendingEditAccess,
    resolveSessionPendingOwnerAccess,
    resolveSessionPendingViewAccess,
} from "@/app/session/pending/resolveSessionPendingAccess";
import type { PendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";
import { db } from "@/storage/db";
import { inTx, isTransactionAcquisitionUnavailableError } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    isStoredContentKindAllowedForSessionByStoragePolicy,
    isPendingDeliveryProviderEffectPossibleV1,
    isPendingDeliveryStatusTransitionAllowedV1,
    normalizePendingDeliveryBlockedReason,
    normalizePendingDeliveryStatusV1,
    pendingDeliveryStatusV1ToPersistedFields,
    PendingRequestedActionV1Schema,
    readPendingLocalId,
    SessionMessageDeliveryResolutionV1Schema,
    type PendingRequestedActionV1,
    type PendingDeliveryBlockedReason,
    type SessionStoredContentKind,
} from "@happier-dev/protocol";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { reserveNextPendingQueuePosition } from "@/app/session/pending/reserveNextPendingQueuePosition";
import { parseSessionMessageRole, resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { markSessionParticipantsChanged } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import {
    createSessionMessageFromPending,
    resolvePendingTranscriptCompatibility,
    type PendingTranscriptMessage,
} from "@/app/session/pending/pendingMessageTranscriptCommit";
import {
    resolveReadyProjectionEventType,
    updateSessionMessageActivityProjection,
    type SessionReadyProjectionUpdate,
} from "@/app/session/sessionWriteService";
import { warn } from "@/utils/logging/log";
import {
    acquireTrustedPendingPublisherAuthority,
    type TrustedPendingPublisherFence,
} from "@/app/session/pending/pendingPublisherAuthority";

type ParticipantCursor = SessionParticipantCursor;
type PendingServiceTx = Parameters<Parameters<typeof inTx>[0]>[0];
type PendingActivationTarget = Readonly<{
    accountId: string;
    requestId: string;
}>;

function isOrdinaryPendingMutationFenced(fields: Readonly<{
    status: unknown;
    deliveryState?: unknown;
    deliveryBlockedReason?: unknown;
}>): boolean {
    return isPendingDeliveryProviderEffectPossibleV1(normalizePendingDeliveryStatusV1(fields));
}

function toPendingMessageRow(row: Readonly<{
    localId: string;
    messageRole?: unknown;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction?: unknown;
    status: string;
    deliveryState?: string | null;
    deliveryBlockedReason?: string | null;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
}>): PendingMessageRow {
    return mapPendingMessageRow({
        ...row,
        status: row.status === "discarded" ? "discarded" : "queued",
    });
}

function isPendingDeliveryResolutionRaceError(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2002") || isPrismaErrorCode(error, "P2025");
}

function readPrismaErrorCode(error: unknown): string | null {
    if (!error || typeof error !== "object" || !("code" in error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : null;
}

type PendingOperationErrorContext = Readonly<{
    operation: "delete" | "provider-acceptance";
    sessionId: string;
    localId: string;
    diagnosticCorrelationId?: string;
    error: unknown;
}>;

function reportPendingOperationError(
    params: PendingOperationErrorContext,
    message:
        | "pending delivery transaction acquisition failed"
        | "pending delivery operation failed",
): void {
    warn(
        {
            module: "session-pending-service",
            operation: params.operation,
            sessionId: params.sessionId,
            localId: params.localId,
            correlationId: params.diagnosticCorrelationId ?? null,
            prismaCode: readPrismaErrorCode(params.error),
            err: params.error,
        },
        message,
        params.error,
    );
}

async function retryPendingDeliveryResolutionRace<T>(operation: () => Promise<T>): Promise<T> {
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
            return { ok: true, pending: rows.map(toPendingMessageRow) };
        }

        const [queued, discarded] = await Promise.all([
            db.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select,
            }),
            db.sessionPendingMessage.findMany({
                where: { sessionId, status: "discarded" },
                orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
                select,
            }),
        ]);

        return { ok: true, pending: [...queued.map(toPendingMessageRow), ...discarded.map(toPendingMessageRow)] };
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
        meaningfulActivityAt?: Date;
        badgeAttentionChanged: boolean;
        participantCursors: ParticipantCursor[];
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
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "requested-action-conflict" | "internal"; code?: EncryptionPolicyRejectionCode };

export async function enqueuePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    messageRole?: unknown;
    deliveryMode?: "external_handoff";
    admissionMode?: "continuation_if_no_queued_user_input";
    requestedAction: PendingRequestedActionV1;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
)): Promise<EnqueuePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const deliveryMode = params.deliveryMode === undefined || params.deliveryMode === "external_handoff"
        ? params.deliveryMode
        : null;
    const admissionMode = params.admissionMode === undefined || params.admissionMode === "continuation_if_no_queued_user_input"
        ? params.admissionMode
        : null;
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const content =
        "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionPendingMessageContent) : null;
    const requestedActionResult = PendingRequestedActionV1Schema.safeParse(params.requestedAction);
    if (!requestedActionResult.success) return { ok: false, error: "invalid-params" };
    const requestedAction = requestedActionResult.data;

    if (!actorUserId || !sessionId || !localId || !content || deliveryMode === null || admissionMode === null) {
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
                    accountId: true,
                    active: true,
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
                },
            });
            if (existing) {
                const existingActionResult = PendingRequestedActionV1Schema.safeParse(existing.requestedAction);
                if (
                    !existingActionResult.success
                    || !isDeepStrictEqual(existing.content, content)
                    || (existing.messageRole !== null && existing.messageRole !== messageRole)
                    || !isDeepStrictEqual(existingActionResult.data, requestedAction)
                ) {
                    return { ok: false, error: "requested-action-conflict" } as const;
                }
                if (existing.status !== "queued") {
                    return { ok: false, error: "requested-action-conflict" } as const;
                }
                if (
                    deliveryMode === "external_handoff"
                    && existing.deliveryState !== "external_handoff"
                ) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                const needsMessageRoleBackfill = existing.messageRole === null && messageRole !== null;
                let pending = existing;
                if (needsMessageRoleBackfill) {
                    const backfillUpdatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
                    const backfilled = await tx.sessionPendingMessage.updateMany({
                        where: {
                            sessionId,
                            localId,
                            status: "queued",
                            ...(needsMessageRoleBackfill ? { messageRole: null } : {}),
                            updatedAt: existing.updatedAt,
                        },
                        data: {
                            messageRole,
                            updatedAt: backfillUpdatedAt,
                        },
                    });
                    if (backfilled.count === 0) {
                        return { ok: false, error: "requested-action-conflict" } as const;
                    }
                    pending = await tx.sessionPendingMessage.findUniqueOrThrow({
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
                        },
                    });
                }
                return {
                    ok: true,
                    didWrite: false,
                    pending: toPendingMessageRow(pending),
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
                    createdAt: true,
                    updatedAt: true,
                },
            });
            if (terminalTranscript) {
                const compatibility = resolvePendingTranscriptCompatibility({
                    existing: terminalTranscript,
                    pending: { content, messageRole },
                });
                if (!compatibility.ok) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                const deliveryResolution = SessionMessageDeliveryResolutionV1Schema.safeParse(
                    terminalTranscript.deliveryResolution,
                );
                return {
                    ok: true,
                    terminal: true,
                    didWrite: false,
                    message: {
                        id: terminalTranscript.id,
                        seq: terminalTranscript.seq,
                        localId: terminalTranscript.localId ?? localId,
                        messageRole: compatibility.existingMessageRole,
                        content: terminalTranscript.content as PrismaJson.SessionMessageContent,
                        requestedAction,
                        ...(deliveryResolution.success ? { deliveryResolution: deliveryResolution.data } : {}),
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
                    authorAccountId: actorUserId,
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
                },
            });

            const activationTarget =
                requestedAction.kind === "send_now"
                && session.active === false
                    ? {
                        accountId: session.accountId,
                        requestId: localId,
                    }
                    : undefined;
            const { pendingCount, pendingBlockedCount, pendingVersion, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: 1,
                meaningfulActivityAt: created.createdAt,
                activationTarget,
            });

            return {
                ok: true,
                didWrite: true,
                pending: toPendingMessageRow(created),
                pendingCount,
                pendingBlockedCount,
                pendingVersion,
                meaningfulActivityAt: created.createdAt,
                badgeAttentionChanged,
                participantCursors,
                ...(activationTarget ? { activationTarget } : {}),
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdatePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal"; code?: EncryptionPolicyRejectionCode };

export async function updatePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    messageRole?: unknown;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
)): Promise<UpdatePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const content =
        "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionPendingMessageContent) : null;

    if (!actorUserId || !sessionId || !localId || !content) return { ok: false, error: "invalid-params" };
    if (content.t === "encrypted" && (!content.c || typeof content.c !== "string")) return { ok: false, error: "invalid-params" };
    if (content.t === "plain" && !("v" in content)) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { encryptionMode: true },
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
                select: { id: true, status: true, deliveryState: true, deliveryBlockedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (isOrdinaryPendingMutationFenced(existing)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: { content, messageRole },
            });

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

export type UpdatePendingRequestedActionResult =
    | { ok: true; didUpdate: boolean; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "action-conflict" | "internal" };

export async function updatePendingRequestedAction(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    requestedAction: PendingRequestedActionV1;
}): Promise<UpdatePendingRequestedActionResult> {
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
        // Freeze the caller's observed row before transaction acquisition. `inTx` may retry its
        // callback, so reading inside it would silently turn a stale writer into a fresh writer on
        // retry. The row revision remains the compare-and-set precondition for every attempt.
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
        if (existing.status !== "queued") {
            return { ok: false, error: "action-conflict" } as const;
        }

        const currentAction = PendingRequestedActionV1Schema.safeParse(existing.requestedAction);
        if (!currentAction.success) {
            return { ok: false, error: "invalid-params" } as const;
        }
        const currentActionValue = currentAction.data;
        const nextUpdatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));

        return await inTx(async (tx) => {
            const retriesProvenPreEffectBlock =
                existing.deliveryState === "blocked"
                && !isPendingDeliveryProviderEffectPossibleV1(normalizePendingDeliveryStatusV1({
                    status: "queued",
                    deliveryState: existing.deliveryState,
                    deliveryBlockedReason: existing.deliveryBlockedReason,
                }));
            if (retriesProvenPreEffectBlock) {
                const updated = await tx.sessionPendingMessage.updateMany({
                    where: {
                        sessionId,
                        localId,
                        status: "queued",
                        deliveryState: "blocked",
                        deliveryBlockedReason: existing.deliveryBlockedReason,
                        providerAction: existing.providerAction,
                        updatedAt: existing.updatedAt,
                    },
                    data: {
                        requestedAction: requestedActionResult.data,
                        deliveryState: null,
                        deliveryBlockedReason: null,
                        providerAction: null,
                        updatedAt: nextUpdatedAt,
                    },
                });
                if (updated.count === 0) {
                    return { ok: false, error: "action-conflict" } as const;
                }
                const state = await applyPendingSessionStateChange({
                    tx,
                    sessionId,
                    pendingBlockedCountDelta: -1,
                });
                return { ok: true, didUpdate: true, ...state } as const;
            }

            // Lifecycle fencing is authoritative even for a same-action retry. Once provider
            // custody may exist, idempotency cannot be used to reopen the mutation window.
            if (existing.deliveryState !== null) {
                return { ok: false, error: "action-conflict" } as const;
            }
            if (existing.providerAction === null && isDeepStrictEqual(currentActionValue, requestedActionResult.data)) {
                const retained = await tx.sessionPendingMessage.count({
                    where: {
                        sessionId,
                        localId,
                        status: "queued",
                        deliveryState: null,
                        providerAction: null,
                        updatedAt: existing.updatedAt,
                    },
                });
                if (retained === 0) {
                    return { ok: false, error: "action-conflict" } as const;
                }
                const session = await tx.session.findUniqueOrThrow({
                    where: { id: sessionId },
                    select: { pendingVersion: true, pendingCount: true, pendingBlockedCount: true },
                });
                return {
                    ok: true,
                    didUpdate: false,
                    pendingVersion: session.pendingVersion,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                } as const;
            }

            const updated = await tx.sessionPendingMessage.updateMany({
                where: {
                    sessionId,
                    localId,
                    status: "queued",
                    deliveryState: null,
                    providerAction: existing.providerAction,
                    updatedAt: existing.updatedAt,
                },
                data: {
                    requestedAction: requestedActionResult.data,
                    providerAction: null,
                    updatedAt: nextUpdatedAt,
                },
            });
            if (updated.count === 0) {
                return { ok: false, error: "action-conflict" } as const;
            }
            const state = await applyPendingSessionStateChange({ tx, sessionId });
            return { ok: true, didUpdate: true, ...state } as const;
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DeletePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "delivery-settlement-conflict" | "internal" }
    | { ok: false; error: "transaction-unavailable"; retryAfterMs: number; correlationId?: string };

export async function deletePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    diagnosticCorrelationId?: string;
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
                select: { status: true, deliveryState: true, deliveryBlockedReason: true },
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
    } catch (error) {
        if (isTransactionAcquisitionUnavailableError(error)) {
            const underlyingError = error.cause;
            reportPendingOperationError({
                operation: "delete",
                sessionId,
                localId,
                diagnosticCorrelationId: params.diagnosticCorrelationId,
                error: underlyingError,
            }, "pending delivery transaction acquisition failed");
            return {
                ok: false,
                error: "transaction-unavailable",
                retryAfterMs: 1_000,
                ...(params.diagnosticCorrelationId ? { correlationId: params.diagnosticCorrelationId } : {}),
            };
        }
        reportPendingOperationError({
            operation: "delete",
            sessionId,
            localId,
            diagnosticCorrelationId: params.diagnosticCorrelationId,
            error,
        }, "pending delivery operation failed");
        return { ok: false, error: "internal" };
    }
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
    deliveryBlockedReason?: string | null;
    discardedReason?: string | null;
    messageRole: string | null;
    content: unknown;
    requestedAction?: unknown;
    position: number;
}>;

type PendingDeliveryBlockRowInput = Readonly<{
    localId: string;
    status: string;
    deliveryState: string | null;
    deliveryBlockedReason?: string | null;
    discardedReason?: string | null;
}>;

async function markPendingDeliveryRowsBlocked(
    tx: PendingServiceTx,
    params: Readonly<{
        sessionId: string;
        rows: readonly PendingDeliveryBlockRowInput[];
        reason: PendingDeliveryBlockedReason;
    }>,
): Promise<Readonly<{ updatedCount: number; pendingBlockedCountDelta: number }>> {
    const target = { status: "blocked", reason: params.reason } as const;
    const rows = params.rows.filter((row) =>
        readPendingLocalId(row.localId) !== null &&
        isPendingDeliveryStatusTransitionAllowedV1(normalizePendingDeliveryStatusV1(row), target)
    );
    const localIds = [...new Set(rows.map((row) => row.localId))];
    if (localIds.length === 0) return { updatedCount: 0, pendingBlockedCountDelta: 0 };

    const pendingBlockedCountDelta = rows.filter((row) => normalizePendingDeliveryStatusV1(row).status !== "blocked").length;
    const persisted = pendingDeliveryStatusV1ToPersistedFields(target);
    const updated = await tx.sessionPendingMessage.updateMany({
        where: {
            sessionId: params.sessionId,
            localId: { in: localIds },
            status: "queued",
        },
        data: { deliveryState: persisted.deliveryState, deliveryBlockedReason: persisted.deliveryBlockedReason },
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
        deliveryResolution?: Readonly<{ v: 1; kind: "manual_handled" }>;
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

    const committed = await createSessionMessageFromPending(tx, {
        sessionId: params.sessionId,
        localId: params.localId,
        content,
        messageRole,
    });
    if (!committed.ok) {
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
    if (params.deliveryResolution) {
        await tx.sessionMessage.update({
            where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
            data: { deliveryResolution: params.deliveryResolution },
        });
    }
    const committedMessage: PendingTranscriptMessage = params.deliveryResolution
        ? { ...committed.message, deliveryResolution: params.deliveryResolution }
        : committed.message;
    const readyProjection = committed.didWrite
        ? await updateSessionMessageActivityProjection(tx, {
            sessionId: params.sessionId,
            created: committedMessage,
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

    const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
        tx,
        sessionId: params.sessionId,
        pendingCountDelta: params.existing.status === "queued" ? -1 : 0,
        pendingBlockedCountDelta: params.existing.status === "queued" && params.existing.deliveryState === "blocked" ? -1 : 0,
    });
    const participantCursorsMessage = committed.didWrite || committed.didUpdate
        ? await markSessionParticipantsChanged({
            tx,
            sessionId: params.sessionId,
            hint: { lastMessageSeq: committedMessage.seq, lastMessageId: committedMessage.id },
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
        message: committedMessage,
        ...(readyProjection ? { readyProjection } : {}),
    };
}

export async function resolveAcceptedPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    trustedPublisherFence: TrustedPendingPublisherFence;
    diagnosticCorrelationId?: string;
}): Promise<ResolveAcceptedPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await retryPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            if (!await acquireTrustedPendingPublisherAuthority({
                tx,
                actorUserId,
                sessionId,
                fence: params.trustedPublisherFence,
            })) {
                return { ok: false, error: "forbidden" } as const;
            }
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true, messageRole: true, content: true, requestedAction: true, position: true },
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
                const deliveryResolution = SessionMessageDeliveryResolutionV1Schema.safeParse(
                    committed.deliveryResolution,
                );
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
                    didResolve: false,
                    message: {
                        id: committed.id,
                        seq: committed.seq,
                        localId: committed.localId ?? localId,
                        messageRole: parseSessionMessageRole(committed.messageRole),
                        content: committed.content as PrismaJson.SessionMessageContent,
                        ...(deliveryResolution.success ? { deliveryResolution: deliveryResolution.data } : {}),
                        createdAt: committed.createdAt,
                        updatedAt: committed.updatedAt,
                    },
                } as const;
            }

            const existingDeliveryStatus = normalizePendingDeliveryStatusV1(existing);
            const isUncertainTombstone = existingDeliveryStatus.status === "discarded"
                && UNCERTAIN_DELIVERY_TOMBSTONE_REASONS.has(existingDeliveryStatus.reason ?? "");
            if (
                !isUncertainTombstone
                && !isPendingDeliveryStatusTransitionAllowedV1(existingDeliveryStatus, { status: "resolved", reason: "provider_accepted" })
            ) {
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
                    didResolve: false,
                } as const;
            }

            const requestedAction = PendingRequestedActionV1Schema.safeParse(existing.requestedAction);
            const isExactAction = requestedAction.success && requestedAction.data.kind !== "enqueue";
            const earlierUnresolved = isUncertainTombstone || isExactAction ? null : await tx.sessionPendingMessage.findFirst({
                where: {
                    sessionId,
                    status: "queued",
                    position: { lt: existing.position },
                },
                select: { localId: true },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            });
            if (earlierUnresolved) {
                return { ok: false, error: "blocked-by-earlier-pending" } as const;
            }

            const resolved = await commitResolvedPendingDelivery(tx, {
                actorUserId,
                sessionId,
                localId,
                existing,
            });
            if (!resolved.ok) return resolved;
            return {
                ...resolved,
                didResolve: true,
            };
        }));
    } catch (error) {
        if (isTransactionAcquisitionUnavailableError(error)) {
            const underlyingError = error.cause;
            reportPendingOperationError({
                operation: "provider-acceptance",
                sessionId,
                localId,
                diagnosticCorrelationId: params.diagnosticCorrelationId,
                error: underlyingError,
            }, "pending delivery transaction acquisition failed");
            return {
                ok: false,
                error: "transaction-unavailable",
                retryAfterMs: 1_000,
                ...(params.diagnosticCorrelationId ? { correlationId: params.diagnosticCorrelationId } : {}),
            };
        }
        reportPendingOperationError({
            operation: "provider-acceptance",
            sessionId,
            localId,
            diagnosticCorrelationId: params.diagnosticCorrelationId,
            error,
        }, "pending delivery operation failed");
        return { ok: false, error: "internal" };
    }
}

async function readCurrentPendingMutationState(tx: PendingServiceTx, sessionId: string) {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
    });
    return {
        pendingVersion: session?.pendingVersion ?? 0,
        pendingCount: session?.pendingCount ?? 0,
        pendingBlockedCount: session?.pendingBlockedCount ?? 0,
        participantCursors: [] as ParticipantCursor[],
        badgeAttentionChanged: false,
    };
}

export type BlockPendingDeliveryResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; didUpdate: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal" };

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
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (existing.status !== "queued") {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false };
            }
            if (existing.deliveryState === "blocked" && existing.deliveryBlockedReason === reason) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false };
            }

            const blocked = await markPendingDeliveryRowsBlocked(tx, {
                sessionId,
                rows: [{
                    localId,
                    status: existing.status,
                    deliveryState: existing.deliveryState,
                    deliveryBlockedReason: existing.deliveryBlockedReason,
                    discardedReason: existing.discardedReason,
                }],
                reason,
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingBlockedCountDelta: blocked.pendingBlockedCountDelta,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged, didUpdate: true };
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
        return await retryPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true, messageRole: true, content: true, requestedAction: true, position: true },
            });
            const canMarkHandled = existing !== null && isPendingDeliveryStatusTransitionAllowedV1(
                normalizePendingDeliveryStatusV1(existing),
                { status: "resolved", reason: "manual_handled" },
            );
            if (!existing || !canMarkHandled) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didResolve: false };
            }

            const resolved = await commitResolvedPendingDelivery(tx, {
                actorUserId,
                sessionId,
                localId,
                existing,
                deliveryResolution: { v: 1, kind: "manual_handled" },
            });
            if (!resolved.ok) return resolved;
            return {
                ...resolved,
                ok: true,
                didResolve: true,
            };
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

const UNCERTAIN_DELIVERY_TOMBSTONE_REASONS = new Set(["dismissed_uncertain", "resent_as_new"]);

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
        return await retryPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (existing.status === "discarded" && existing.discardedReason === "dismissed_uncertain") {
                return { ok: true, didDismiss: false, ...(await readCurrentPendingMutationState(tx, sessionId)) } as const;
            }
            if (!isPendingDeliveryProviderEffectPossibleV1(normalizePendingDeliveryStatusV1(existing))) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: "discarded",
                    deliveryState: null,
                    deliveryBlockedReason: null,
                    discardedAt: now,
                    discardedReason: "dismissed_uncertain",
                },
            });
            const state = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: -1,
                pendingBlockedCountDelta: existing.deliveryState === "blocked" ? -1 : 0,
            });
            return { ok: true, didDismiss: true, ...state } as const;
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

function derivePendingSendAsNewLocalId(sessionId: string, localId: string): string {
    const digest = createHash("sha256")
        .update(`happier.pending.send-as-new.v1\0${sessionId}\0${localId}`, "utf8")
        .digest("hex");
    return `send-as-new-${digest}`;
}

export type SendPendingDeliveryAsNewResult =
    | { ok: true; didWrite: boolean; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "identity-conflict" | "internal" };

export async function sendPendingDeliveryAsNew(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    now?: Date;
}): Promise<SendPendingDeliveryAsNewResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const now = params.now instanceof Date ? params.now : new Date();
    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };
    const replacementLocalId = derivePendingSendAsNewLocalId(sessionId, localId);

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await retryPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    discardedReason: true,
                    messageRole: true,
                    content: true,
                },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;

            const replacement = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId: replacementLocalId } },
                select: { status: true, deliveryState: true, messageRole: true, content: true, requestedAction: true },
            });
            if (existing.status === "discarded" && existing.discardedReason === "resent_as_new") {
                const action = replacement ? PendingRequestedActionV1Schema.safeParse(replacement.requestedAction) : null;
                if (
                    !replacement
                    || replacement.status !== "queued"
                    || replacement.deliveryState !== null
                    || replacement.messageRole !== existing.messageRole
                    || !isDeepStrictEqual(replacement.content, existing.content)
                    || !action?.success
                    || action.data.kind !== "enqueue"
                ) {
                    return { ok: false, error: "identity-conflict" } as const;
                }
                return { ok: true, didWrite: false, ...(await readCurrentPendingMutationState(tx, sessionId)) } as const;
            }
            if (!isPendingDeliveryProviderEffectPossibleV1(normalizePendingDeliveryStatusV1(existing))) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (replacement) return { ok: false, error: "identity-conflict" } as const;

            const position = await reserveNextPendingQueuePosition(tx, sessionId);
            await tx.sessionPendingMessage.create({
                data: {
                    sessionId,
                    localId: replacementLocalId,
                    messageRole: existing.messageRole,
                    content: existing.content as PrismaJson.SessionPendingMessageContent,
                    requestedAction: { v: 1, kind: "enqueue" },
                    status: "queued",
                    deliveryState: null,
                    position,
                    authorAccountId: actorUserId,
                },
            });
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: "discarded",
                    deliveryState: null,
                    deliveryBlockedReason: null,
                    discardedAt: now,
                    discardedReason: "resent_as_new",
                },
            });
            const state = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingBlockedCountDelta: existing.deliveryState === "blocked" ? -1 : 0,
            });
            return { ok: true, didWrite: true, ...state } as const;
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DiscardPendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
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

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (existing.status === "discarded" && UNCERTAIN_DELIVERY_TOMBSTONE_REASONS.has(existing.discardedReason ?? "")) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            if (isOrdinaryPendingMutationFenced(existing)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            if (existing.status !== "queued") {
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

            const discarded = { status: "discarded", reason } as const;
            if (!isPendingDeliveryStatusTransitionAllowedV1(normalizePendingDeliveryStatusV1(existing), discarded)) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)) } as const;
            }
            const persistedDiscarded = pendingDeliveryStatusV1ToPersistedFields(discarded);
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: persistedDiscarded.status,
                    deliveryState: persistedDiscarded.deliveryState,
                    deliveryBlockedReason: persistedDiscarded.deliveryBlockedReason,
                    discardedAt: now,
                    discardedReason: persistedDiscarded.discardedReason,
                },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: -1,
                pendingBlockedCountDelta: existing.deliveryState === "blocked" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type RestorePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
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
            if (existing.status === "discarded" && UNCERTAIN_DELIVERY_TOMBSTONE_REASONS.has(existing.discardedReason ?? "")) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (isOrdinaryPendingMutationFenced(existing)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            const queued = { status: "queued" } as const;
            if (isPendingDeliveryStatusTransitionAllowedV1(normalizePendingDeliveryStatusV1(existing), queued)) {
                const position = await reserveNextPendingQueuePosition(tx, sessionId);
                const persistedQueued = pendingDeliveryStatusV1ToPersistedFields(queued);

                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: {
                        status: persistedQueued.status,
                        deliveryState: persistedQueued.deliveryState,
                        deliveryBlockedReason: persistedQueued.deliveryBlockedReason,
                        discardedAt: null,
                        discardedReason: persistedQueued.discardedReason,
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
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "delivery-settlement-conflict" | "internal" };

export async function reorderPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    orderedLocalIds: string[];
}): Promise<ReorderPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const orderedLocalIds = Array.isArray(params.orderedLocalIds)
        ? params.orderedLocalIds.filter((value): value is string => readPendingLocalId(value) !== null)
        : [];

    if (
        !actorUserId
        || !sessionId
        || orderedLocalIds.length === 0
        || orderedLocalIds.length !== params.orderedLocalIds.length
    ) return { ok: false, error: "invalid-params" };
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
    materializeNextPendingMessage,
    materializeNextPendingMessageForCurrentPublisher,
} from "@/app/session/pending/materializeNextPendingMessage";
