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
    isStoredContentKindAllowedForSessionByStoragePolicy,
    isPendingDeliveryArchivedUncertaintyReasonV1,
    isPendingDeliveryProviderEffectPossibleV1,
    isPendingDeliveryStatusTransitionAllowedV1,
    normalizePendingDeliveryBlockedReason,
    normalizePendingDeliveryStatusV1,
    normalizePendingRequestedActionV1,
    isPendingLocalId,
    readPendingLocalId,
    PendingRequestedActionV1Schema,
    parseSessionMessageDeliveryResolutionV1,
    pendingDeliveryStatusV1ToPersistedFields,
    type PendingDeliveryBlockedReason,
    type PendingDeliveryStatusTransitionTargetV1,
    type PendingDeliveryStatusV1,
    type PendingRequestedActionV1,
    type SessionStoredContentKind,
} from "@happier-dev/protocol";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { reserveNextPendingQueuePosition } from "@/app/session/pending/reserveNextPendingQueuePosition";
import { parseSessionMessageRole, resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { hasExactCurrentPublisherAuthorityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
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
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { warn } from "@/utils/logging/log";

type ParticipantCursor = SessionParticipantCursor;
type PendingActivationTarget = Readonly<{
    accountId: string;
    requestId: string;
}>;
type PendingServiceTx = Tx;

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
                where: { sessionId, status: "discarded" },
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
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal"; code?: EncryptionPolicyRejectionCode };

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
    const requestedActionResult = PendingRequestedActionV1Schema.safeParse(params.requestedAction);
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const content =
        "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionPendingMessageContent) : null;

    if (!actorUserId || !sessionId || !localId || !content || deliveryMode === null || admissionMode === null || !requestedActionResult.success) {
        return { ok: false, error: "invalid-params" };
    }
    const requestedAction = requestedActionResult.data;
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
                if (!isDeepStrictEqual(existing.content, content) || (existing.messageRole !== null && existing.messageRole !== messageRole)) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                let pending = existing;
                if (
                    existing.messageRole === null
                    && messageRole !== null
                    && isDeepStrictEqual(existing.content, content)
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

export type UpdatePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal"; code?: EncryptionPolicyRejectionCode };

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
        const canReplaceUnavailableSteer = existing.status === "queued"
            && existing.deliveryState === "blocked"
            && existing.deliveryBlockedReason === "steering_unavailable"
            && (currentAction.kind === "steer_now" || currentAction.kind === "steer_if_active")
            && requestedActionResult.data.kind === "send_now";
        if (!canReplaceQueued && !canReplaceUnavailableSteer) {
            return { ok: false, error: "action-conflict" } as const;
        }
        const frozenWhere = {
            sessionId,
            localId,
            status: "queued" as const,
            deliveryState: canReplaceUnavailableSteer ? "blocked" as const : null,
            deliveryBlockedReason: existing.deliveryBlockedReason,
            updatedAt: existing.updatedAt,
            ...(existing.requestedAction === null
                ? {}
                : { requestedAction: { equals: existing.requestedAction } }),
        };
        const nextUpdatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));

        return await inTx(async (tx) => {
            if (!canReplaceUnavailableSteer && isDeepStrictEqual(currentAction, requestedActionResult.data)) {
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
                    requestedAction: requestedActionResult.data,
                    // Keep this predicate usable as the CAS token even on databases whose
                    // implicit @updatedAt value can retain the same coarse timestamp.
                    updatedAt: nextUpdatedAt,
                    ...(canReplaceUnavailableSteer
                        ? { deliveryState: null, deliveryBlockedReason: null }
                        : {}),
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
                select: { id: true, status: true, deliveryState: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (
                existing.deliveryState === "delivering"
                || existing.deliveryState === "external_handoff"
            ) {
                return { ok: false, error: "not-found" } as const;
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
                select: { status: true, deliveryState: true, discardedReason: true },
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
            if (existing.deliveryState === "delivering") {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (existing.status === "discarded" && isPendingDeliveryArchivedUncertaintyReasonV1(existing.discardedReason)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (existing.deliveryState === "external_handoff") {
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
    position: number;
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

    const committed = await createSessionMessageFromPending(tx, {
        sessionId: params.sessionId,
        sessionEncryptionMode,
        storagePolicy: policy.storagePolicy,
        localId: params.localId,
        content,
        messageRole,
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
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true, messageRole: true, content: true, position: true },
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
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

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
                select: { localId: true, deliveryState: true, position: true },
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
                    (row.deliveryState === "delivering" || row.deliveryState === "external_handoff")
                    && orderedIndexByLocalId.get(row.localId) !== existingIndex
                ) {
                    return { ok: false, error: "invalid-params" } as const;
                }
            }

            let position = 1;
            for (const localId of orderedLocalIds) {
                const row = queuedByLocalId.get(localId);
                if (
                    row?.deliveryState === "delivering"
                    || row?.deliveryState === "external_handoff"
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
export { materializeNextPendingMessage } from "@/app/session/pending/materializeNextPendingMessage";
